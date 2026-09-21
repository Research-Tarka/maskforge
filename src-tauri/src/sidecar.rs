//! Sidecar process management.
//!
//! Responsible for launching the MaskForge Python sidecar (a local FastAPI +
//! uvicorn HTTP server), reading its dynamically-assigned port from stdout,
//! storing that port in Tauri managed state so `commands::get_sidecar_port`
//! can hand it to the frontend, and making sure the child process is killed
//! when the app shuts down.
//!
//! ## Dev vs. prod
//!
//! - **Dev** (`spawn_sidecar_dev`): spawns `python -m api.server` directly
//!   with its cwd set to the sibling `sidecar/` directory, resolved via
//!   `CARGO_MANIFEST_DIR` (stable regardless of the process's current
//!   working directory).
//! - **Prod** (`spawn_sidecar_prod`): launches the PyInstaller onefile
//!   binary via Tauri's `externalBin` / `Command::sidecar` mechanism (see
//!   `bundle.externalBin` in `tauri.conf.json`, pointing at
//!   `binaries/maskforge-sidecar`).
//!
//! `spawn_sidecar()` is the single entry point `main.rs` calls; it branches
//! on `cfg!(debug_assertions)`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// Prefixes the sidecar prints on stdout once its HTTP server is bound and
/// ready: the port on one line, then a random per-launch auth token on the
/// next — every request but /health must present this token (see
/// sidecar/api/server.py's require_auth_token middleware). See
/// docs/IPC_CONTRACT.md.
const PORT_MARKER: &str = "MASKFORGE_PORT=";
const TOKEN_MARKER: &str = "MASKFORGE_TOKEN=";

/// How long we wait for the sidecar to print its port line before giving up
/// and letting the app continue with no sidecar connection (visible error
/// state in the UI, rather than an indefinite hang at startup).
///
/// Generous on purpose: the prod sidecar is a ~150 MB PyInstaller onefile
/// binary (bundling GDAL/rasterio) that self-extracts into a temp dir on
/// first launch, and a real-time antivirus scanning that extraction can
/// push a cold start well past 10s on a slower or more loaded machine —
/// even though the same binary starts in well under a second once warm.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);

/// Either kind of child process we might spawn: a plain OS `Child` in dev
/// mode (`python -m api.server`), or a `tauri_plugin_shell` sidecar handle
/// in prod mode (the bundled PyInstaller binary launched via `externalBin`).
enum SidecarChild {
    Plain(Child),
    Shell(tauri_plugin_shell::process::CommandChild),
}

/// Shared state, managed by Tauri, tracking the sidecar's assigned port,
/// its per-launch auth token, and its child process handle so it can be
/// killed on shutdown.
pub struct SidecarState {
    /// 0 means "not yet known / failed to start".
    port: AtomicU32,
    /// Empty string means "not yet known / failed to start". Only ever set
    /// once at startup from the sidecar's own stdout — never accepted from
    /// any other source, so a compromised frontend can't overwrite it.
    token: Mutex<String>,
    child: Mutex<Option<SidecarChild>>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            port: AtomicU32::new(0),
            token: Mutex::new(String::new()),
            child: Mutex::new(None),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst) as u16
    }

    pub fn token(&self) -> String {
        self.token.lock().unwrap().clone()
    }

    fn set_port(&self, port: u16) {
        self.port.store(port as u32, Ordering::SeqCst);
    }

    fn set_token(&self, token: String) {
        *self.token.lock().unwrap() = token;
    }

    fn set_child(&self, child: SidecarChild) {
        *self.child.lock().unwrap() = Some(child);
    }

    /// Kill the sidecar child process (and its full process tree) if still
    /// running. Safe to call multiple times (e.g. from an exit hook and a
    /// Drop impl).
    ///
    /// A plain `Child::kill()` (or the shell plugin's equivalent) only
    /// signals the direct child PID. On Windows, the process we spawn is
    /// either the venv's `python.exe` stub (dev mode; see
    /// sidecar/.venv/pyvenv.cfg) or the PyInstaller onefile binary (prod
    /// mode), both of which re-exec/unpack into a *child* process —
    /// killing just the direct PID leaves the actual uvicorn process (and
    /// the HTTP server holding the port) running as an orphan. `taskkill
    /// /T /F` kills the whole tree.
    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.take() {
                let pid = match &child {
                    SidecarChild::Plain(c) => c.id(),
                    SidecarChild::Shell(c) => c.pid(),
                };

                #[cfg(windows)]
                let tree_killed = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|status| status.success())
                    .unwrap_or(false);
                #[cfg(not(windows))]
                let tree_killed = false;

                if tree_killed {
                    eprintln!("[sidecar] process tree for pid {pid} terminated");
                    return;
                }

                // Fallback: at least kill the direct child if the tree-kill
                // approach isn't available/failed (e.g. non-Windows, or the
                // process already exited on its own).
                let result: Result<(), String> = match child {
                    SidecarChild::Plain(mut c) => c.kill().map(|()| {
                        let _ = c.wait();
                    }).map_err(|err| err.to_string()),
                    SidecarChild::Shell(c) => c.kill().map_err(|err| err.to_string()),
                };
                match result {
                    Ok(()) => eprintln!("[sidecar] child process terminated"),
                    Err(err) => eprintln!("[sidecar] failed to kill child process: {err}"),
                }
            }
        }
    }
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Directory containing this crate's `Cargo.toml` at compile time — stable
/// regardless of the process's runtime `cwd`. Used to resolve the sibling
/// `sidecar/` directory in dev mode.
fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Resolve the sidecar source directory (`<repo_root>/sidecar`) relative to
/// this crate, which lives at `<repo_root>/src-tauri`.
fn dev_sidecar_dir() -> PathBuf {
    manifest_dir()
        .parent()
        .expect("src-tauri should have a parent directory (repo root)")
        .join("sidecar")
}

/// Spawn the sidecar. Branches on build profile: dev mode runs the Python
/// sidecar straight from source via `python -m api.server`; production mode
/// uses the bundled PyInstaller binary through Tauri's sidecar mechanism.
///
/// Returns the initialized `SidecarState` (already inserted with the parsed
/// port, or port 0 if startup failed/timed out — the app keeps running
/// either way, per the "don't hang app startup" requirement).
pub fn spawn_sidecar(app: &AppHandle) -> SidecarState {
    let state = SidecarState::new();

    let result = if cfg!(debug_assertions) {
        spawn_sidecar_dev()
    } else {
        spawn_sidecar_prod(app)
    };

    match result {
        Ok((child, port, token)) => {
            eprintln!("[sidecar] ready on 127.0.0.1:{port}");
            state.set_child(child);
            state.set_port(port);
            state.set_token(token);
        }
        Err(err) => {
            eprintln!("[sidecar] failed to start: {err}. The app window will still open.");
        }
    }

    state
}

/// Resolve the Python interpreter to launch the sidecar with: prefer the
/// sidecar's own virtualenv (created via `python -m venv .venv` per
/// README.md, and the only place rasterio/GDAL etc. are installed), falling
/// back to whatever `python` is on PATH so a fresh checkout without a venv
/// yet still gets a clear runtime error from uvicorn/import failures rather
/// than a confusing "python not found".
fn resolve_python_interpreter(sidecar_dir: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    let venv_python = sidecar_dir.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(windows))]
    let venv_python = sidecar_dir.join(".venv").join("bin").join("python");

    if venv_python.is_file() {
        venv_python
    } else {
        PathBuf::from("python")
    }
}

/// Dev-mode spawn: `python -m uvicorn api.server:app --port 0`, cwd set to
/// the sibling `sidecar/` directory. Reads stdout line-by-line looking for
/// `MASKFORGE_PORT=<port>`, bounded by `STARTUP_TIMEOUT`.
fn spawn_sidecar_dev() -> Result<(SidecarChild, u16, String), String> {
    let sidecar_dir = dev_sidecar_dir();
    if !sidecar_dir.is_dir() {
        return Err(format!(
            "sidecar directory not found at {}",
            sidecar_dir.display()
        ));
    }

    let python = resolve_python_interpreter(&sidecar_dir);

    // `python -m api.server` (not `python -m uvicorn api.server:app`) is the
    // entry point that actually prints `MASKFORGE_PORT=<port>` before
    // handing off to uvicorn — see sidecar/api/server.py's `main()`. Running
    // uvicorn directly against the `app` object would bind a port without
    // ever emitting that marker line.
    eprintln!(
        "[sidecar] (dev) spawning `{} -m api.server` in {}",
        python.display(),
        sidecar_dir.display()
    );

    let mut child = Command::new(&python)
        .args(["-m", "api.server"])
        .current_dir(&sidecar_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| format!("failed to spawn python sidecar ({}): {err}", python.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar child process had no stdout handle".to_string())?;

    let (port, token) = read_port_and_token_with_timeout(stdout, STARTUP_TIMEOUT)?;
    Ok((SidecarChild::Plain(child), port, token))
}

/// Production spawn: uses `tauri_plugin_shell`'s `Command::sidecar(...)` to
/// launch the PyInstaller-built, target-triple-named binary referenced by
/// `bundle.externalBin` in `tauri.conf.json` (resolved to
/// `maskforge-sidecar-<target-triple>` at runtime, e.g.
/// `maskforge-sidecar-x86_64-pc-windows-msvc.exe`). Reads stdout events for
/// the same `MASKFORGE_PORT=`/`MASKFORGE_TOKEN=` marker lines the dev spawn
/// looks for, bounded by `STARTUP_TIMEOUT`.
fn spawn_sidecar_prod(app: &AppHandle) -> Result<(SidecarChild, u16, String), String> {
    let shell = app.shell();
    let command = shell
        .sidecar("maskforge-sidecar")
        .map_err(|err| format!("failed to resolve sidecar binary: {err}"))?;

    let (mut rx, child) = command
        .spawn()
        .map_err(|err| format!("failed to spawn sidecar binary: {err}"))?;

    let (tx, result_rx) = std::sync::mpsc::channel::<Result<(u16, String), String>>();

    std::thread::spawn(move || {
        let mut port: Option<u16> = None;
        while let Some(event) = tauri::async_runtime::block_on(rx.recv()) {
            match event {
                CommandEvent::Stdout(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        if line.starts_with(TOKEN_MARKER) {
                            eprintln!("[sidecar] MASKFORGE_TOKEN=<redacted>");
                        } else {
                            eprintln!("[sidecar] {line}");
                        }

                        if let Some(rest) = line.strip_prefix(PORT_MARKER) {
                            match rest.trim().parse::<u16>() {
                                Ok(p) => port = Some(p),
                                Err(err) => {
                                    let _ = tx.send(Err(format!(
                                        "could not parse port from line {line:?}: {err}"
                                    )));
                                    return;
                                }
                            }
                            continue;
                        }
                        if let Some(rest) = line.strip_prefix(TOKEN_MARKER) {
                            let Some(p) = port else {
                                let _ = tx.send(Err(
                                    "sidecar printed the token before the port".to_string(),
                                ));
                                return;
                            };
                            let _ = tx.send(Ok((p, rest.trim().to_string())));
                            return;
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Error(err) => {
                    let _ = tx.send(Err(format!("sidecar process error: {err}")));
                    return;
                }
                CommandEvent::Terminated(payload) => {
                    let _ = tx.send(Err(format!(
                        "sidecar process exited before printing startup markers (code {:?})",
                        payload.code
                    )));
                    return;
                }
                _ => {}
            }
        }
        let _ = tx.send(Err(
            "sidecar stdout closed before printing MASKFORGE_PORT=<port> and MASKFORGE_TOKEN=<token>"
                .to_string(),
        ));
    });

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let (port, token) = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "timed out after {STARTUP_TIMEOUT:?} waiting for sidecar startup markers"
            ));
        }
        match result_rx.recv_timeout(remaining) {
            Ok(result) => break result?,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "timed out after {STARTUP_TIMEOUT:?} waiting for sidecar startup markers"
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("sidecar stdout reader thread ended unexpectedly".to_string());
            }
        }
    };

    Ok((SidecarChild::Shell(child), port, token))
}

/// Read lines from `stdout` until both `MASKFORGE_PORT=<port>` and
/// `MASKFORGE_TOKEN=<token>` have been seen (in that order — see
/// sidecar/api/server.py's `main()`) or the timeout elapses. Runs on a
/// background thread with a channel so we can enforce a hard deadline even
/// though `BufRead::lines()` blocks.
fn read_port_and_token_with_timeout(
    stdout: std::process::ChildStdout,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(u16, String), String>>();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut port: Option<u16> = None;
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    // Never echo the token line itself to our own stderr —
                    // it ends up in the same log stream a developer might
                    // paste/share, and the port alone is not sensitive.
                    if line.trim().starts_with(TOKEN_MARKER) {
                        eprintln!("[sidecar] MASKFORGE_TOKEN=<redacted>");
                    } else {
                        eprintln!("[sidecar] {line}");
                    }

                    if let Some(rest) = line.trim().strip_prefix(PORT_MARKER) {
                        match rest.trim().parse::<u16>() {
                            Ok(p) => port = Some(p),
                            Err(err) => {
                                let _ = tx.send(Err(format!(
                                    "could not parse port from line {line:?}: {err}"
                                )));
                                return;
                            }
                        }
                        continue;
                    }
                    if let Some(rest) = line.trim().strip_prefix(TOKEN_MARKER) {
                        let Some(p) = port else {
                            let _ = tx.send(Err(
                                "sidecar printed the token before the port".to_string(),
                            ));
                            return;
                        };
                        let _ = tx.send(Ok((p, rest.trim().to_string())));
                        return;
                    }
                }
                Err(err) => {
                    let _ = tx.send(Err(format!("error reading sidecar stdout: {err}")));
                    return;
                }
            }
        }
        // Stdout closed without ever printing both markers.
        let _ = tx.send(Err(
            "sidecar stdout closed before printing MASKFORGE_PORT=<port> and MASKFORGE_TOKEN=<token>"
                .to_string(),
        ));
    });

    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "timed out after {timeout:?} waiting for sidecar startup markers"
            ));
        }
        match rx.recv_timeout(remaining) {
            Ok(result) => return result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "timed out after {timeout:?} waiting for sidecar startup markers"
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("sidecar stdout reader thread ended unexpectedly".to_string());
            }
        }
    }
}
