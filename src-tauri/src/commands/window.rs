//! What closing the main window does. Desktop only: the headless server has no window.

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Event asking the frontend which way to close (`close_action` is "ask").
pub const CLOSE_REQUESTED_EVENT: &str = "close-requested";

/// `AppSettings::close_action` values.
pub const CLOSE_ASK: &str = "ask";
pub const CLOSE_TRAY: &str = "tray";
pub const CLOSE_QUIT: &str = "quit";

/// Hide `window` to the tray (downloads keep running) or quit the app.
fn close_with<R: Runtime>(app: &AppHandle<R>, window: Option<WebviewWindow<R>>, action: &str) -> Result<(), String> {
    match action {
        CLOSE_TRAY => {
            if let Some(w) = window {
                w.hide().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        CLOSE_QUIT => {
            app.exit(0);
            Ok(())
        }
        other => Err(format!("Unknown close action: {}", other)),
    }
}

/// The window's close button: act on the saved `close_action`, or ask the frontend.
/// Falls back to hiding to the tray when the frontend can't be asked.
pub fn on_close_requested<R: Runtime>(window: &tauri::Window<R>) {
    let app = window.app_handle();
    // try_read: this runs on the UI thread, which must never wait on the lock (a busy lock asks).
    let action = app
        .state::<crate::state::AppState>()
        .settings
        .try_read()
        .map(|s| s.close_action.clone())
        .unwrap_or_else(|_| CLOSE_ASK.to_string());
    let main = app.get_webview_window(window.label());
    if action == CLOSE_ASK {
        if let Some(w) = &main {
            let _ = w.show();
            let _ = w.set_focus();
            if w.emit(CLOSE_REQUESTED_EVENT, ()).is_ok() {
                return;
            }
        }
        let _ = close_with(app, main, CLOSE_TRAY);
    } else if close_with(app, main.clone(), &action).is_err() {
        let _ = close_with(app, main, CLOSE_TRAY);
    }
}

/// Run the choice made in the close dialog: "tray" or "quit".
#[tauri::command]
pub async fn close_main_window(app: AppHandle, action: String) -> Result<(), String> {
    let window = app.get_webview_window("main");
    close_with(&app, window, &action)
}
