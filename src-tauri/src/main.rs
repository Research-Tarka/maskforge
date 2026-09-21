// Prevents an additional console window from appearing on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod sidecar;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Spawn the Python sidecar and stash its state (port + child
            // handle) as Tauri managed state. See src/sidecar.rs for the
            // dev-vs-prod branching logic.
            let sidecar_state = sidecar::spawn_sidecar(app.handle());
            app.manage(sidecar_state);

            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_sidecar_port,
            commands::get_sidecar_token,
            commands::pick_folder,
            commands::pick_file,
        ])
        .on_window_event(|window, event| {
            // Make sure the sidecar dies with the last window, even before
            // the full app-exit path runs (e.g. some platforms tear down
            // windows without immediately firing process exit).
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<sidecar::SidecarState>() {
                    state.kill();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the MaskForge Tauri application")
        .run(|app_handle, event| {
            // Belt-and-suspenders: also kill the sidecar on the general
            // exit-requested event so no orphaned python process survives
            // the app closing under any exit path.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<sidecar::SidecarState>() {
                    state.kill();
                }
            }
        });
}
