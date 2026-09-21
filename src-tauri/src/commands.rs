//! Tauri commands exposed to the frontend via `invoke(...)`.

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::sidecar::SidecarState;

/// Returns the local port the Python sidecar's HTTP server is bound to
/// (`127.0.0.1:<port>`), as parsed from its `MASKFORGE_PORT=<port>` stdout
/// line at startup. Returns `0` if the sidecar failed to start or hasn't
/// reported its port yet — the frontend should treat `0` as "sidecar
/// unavailable" and surface an error state rather than attempting requests.
///
/// Frontend usage: `await invoke<number>("get_sidecar_port")`.
#[tauri::command]
pub fn get_sidecar_port(state: State<'_, SidecarState>) -> u16 {
    state.port()
}

/// Returns the per-launch secret the frontend must send as the
/// `X-MaskForge-Token` header on every sidecar request (except /health) —
/// see sidecar/api/server.py's require_auth_token middleware. Empty string
/// if the sidecar failed to start; the frontend should treat that the same
/// as port 0 (sidecar unavailable).
///
/// Frontend usage: `await invoke<string>("get_sidecar_token")`.
#[tauri::command]
pub fn get_sidecar_token(state: State<'_, SidecarState>) -> String {
    state.token()
}

/// Opens a native folder picker dialog. Returns `None` if the user cancels.
///
/// Used by the frontend to populate `DiscoveryConfig.source_root` and
/// `SaveConfig.output_root` (see docs/IPC_CONTRACT.md).
///
/// Frontend usage: `await invoke<string | null>("pick_folder")`.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |result| {
        let _ = tx.send(result);
    });
    match rx.await {
        Ok(Some(path)) => Some(path.to_string()),
        _ => None,
    }
}

/// Opens a native single-file picker dialog. Returns `None` if the user
/// cancels. Provided as a small extra convenience beyond the strict
/// `source_root` / `output_root` needs (e.g. picking a single scene file or
/// a session JSON to import).
///
/// Frontend usage: `await invoke<string | null>("pick_file")`.
#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |result| {
        let _ = tx.send(result);
    });
    match rx.await {
        Ok(Some(path)) => Some(path.to_string()),
        _ => None,
    }
}
