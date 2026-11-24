//! Tauri wrappers; the bodies live in `crate::service::stats`.
use crate::persistence::Persistence;
use crate::service::stats as svc;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_provider_stats(state: State<'_, AppState>) -> Result<Vec<svc::ProviderStats>, String> {
    Ok(svc::get_provider_stats(&state).await)
}

#[tauri::command]
pub async fn reset_provider_stats(state: State<'_, AppState>, persistence: State<'_, Persistence>) -> Result<(), String> {
    svc::reset_provider_stats(&state, &persistence).await
}
