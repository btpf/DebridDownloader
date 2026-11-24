use crate::persistence::Persistence;
use crate::providers::real_debrid::client::RdClient;
use crate::providers::types::{
    AuthMethod, DeviceCode, DeviceCredentials, OAuthToken, ProviderAccount, ProviderAuth, ProviderInfo, User,
};
use crate::providers::DebridProvider;
use crate::secrets::SecretStore;
use crate::state::{AppState, ProviderPref};
use std::sync::Arc;

fn map_keyring_save_error(context: &str, msg: String) -> String {
    if msg.contains("Windows error code 8") {
        format!(
            "Failed to save {}: Windows Credential Manager is full. \
             Open Credential Manager (Win+R \u{2192} control /name Microsoft.CredentialManager) \
             and remove unused credentials under \"Windows Credentials\", then try again.",
            context
        )
    } else {
        format!("Failed to save {}: {}", context, msg)
    }
}

pub fn prefixed_key(provider_id: &str, key: &str) -> String {
    format!("{}.{}", provider_id, key)
}

/// Change the priority list (always the full, normalized list) and persist it.
async fn update_prefs(
    state: &AppState,
    persistence: &Persistence,
    change: impl FnOnce(&mut Vec<ProviderPref>),
) -> Result<(), String> {
    let mut settings = state.settings.write().await;
    let mut next = settings.clone();
    next.normalize_providers();
    change(&mut next.providers);
    next.normalize_providers();
    crate::service::settings::save_app_settings(persistence, &next)?;
    *settings = next;
    Ok(())
}

fn enable(prefs: &mut [ProviderPref], provider_id: &str) {
    if let Some(p) = prefs.iter_mut().find(|p| p.id == provider_id) {
        p.enabled = true;
    }
}

/// Validate `token` with provider `provider_id` (the primary one when `None`), then save it,
/// remember the account, and enable the provider.
pub async fn set_api_token(
    state: &AppState,
    persistence: &Persistence,
    secrets: &dyn SecretStore,
    token: String,
    provider_id: Option<&str>,
) -> Result<(), String> {
    let (provider_id, provider) = state.provider_for(provider_id).await?;
    // Validate token before persisting
    let user = provider
        .authenticate(&ProviderAuth::Token(token.clone()))
        .await
        .map_err(|e| format!("{}", e))?;

    // Only save the secret after validation succeeds
    secrets
        .set(&prefixed_key(&provider_id, "api_token"), &token)
        .map_err(|e| map_keyring_save_error("token", e))?;
    state.provider_users.write().await.insert(provider_id.clone(), user);
    update_prefs(state, persistence, |prefs| enable(prefs, &provider_id)).await
}

/// Load every provider's saved token from the secret store and sign each in (concurrently).
/// Returns whether any provider had a saved token.
pub async fn load_saved_token(state: &AppState, secrets: &dyn SecretStore) -> Result<bool, String> {
    let clients: Vec<(String, Arc<dyn DebridProvider>)> =
        state.providers.read().await.iter().map(|(id, p)| (id.clone(), p.clone())).collect();
    let saved: Vec<(String, Arc<dyn DebridProvider>, String)> = clients
        .into_iter()
        .filter_map(|(id, p)| match secrets.get(&prefixed_key(&id, "api_token")) {
            Ok(Some(token)) => Some((id, p, token)),
            Ok(None) | Err(_) => None,
        })
        .collect();
    let any = !saved.is_empty();
    let results = futures::future::join_all(saved.into_iter().map(|(id, p, token)| async move {
        let user = p.authenticate(&ProviderAuth::Token(token)).await;
        (id, user)
    }))
    .await;
    let mut users = state.provider_users.write().await;
    for (id, user) in results {
        match user {
            Ok(u) => {
                users.insert(id, u);
            }
            Err(e) => log::warn!("Saved {} token did not authenticate: {}", id, e),
        }
    }
    Ok(any)
}

/// Clear stored credentials and reset provider `provider_id`, or every provider when `None`.
/// The provider keeps its place and enabled flag in the priority list.
pub async fn logout(state: &AppState, secrets: &dyn SecretStore, provider_id: Option<&str>) -> Result<(), String> {
    let ids: Vec<String> = match provider_id.filter(|s| !s.is_empty()) {
        Some(id) => vec![state.provider_for(Some(id)).await?.0],
        None => state.providers.read().await.keys().cloned().collect(),
    };
    for id in ids {
        // Clear all possible credential keys for this provider
        for key in &["api_token", "refresh_token", "oauth_client_id", "oauth_client_secret"] {
            let _ = secrets.delete(&prefixed_key(&id, key));
        }
        // Reset provider to a fresh instance
        state.install_provider(&id, create_provider(&id)?).await;
        state.provider_users.write().await.remove(&id);
    }
    Ok(())
}

/// Whether any provider is signed in (enabled or not), so the app has an account to work with.
pub async fn is_authenticated(state: &AppState) -> bool {
    let clients: Vec<Arc<dyn DebridProvider>> = state.providers.read().await.values().cloned().collect();
    for client in clients {
        if client.is_authenticated().await {
            return true;
        }
    }
    false
}

/// Account of provider `provider_id` (the primary one when `None`), checked with its saved token.
pub async fn get_user(state: &AppState, secrets: &dyn SecretStore, provider_id: Option<&str>) -> Result<User, String> {
    let (provider_id, provider) = state.provider_for(provider_id).await?;
    let token = secrets
        .get(&prefixed_key(&provider_id, "api_token"))
        .ok()
        .flatten()
        .ok_or_else(|| "No saved token".to_string())?;
    let user = provider
        .authenticate(&ProviderAuth::Token(token))
        .await
        .map_err(|e| format!("{}", e))?;
    state.provider_users.write().await.insert(provider_id, user.clone());
    Ok(user)
}

/// Every provider in priority order: whether it's enabled and signed in, and its account.
pub async fn get_provider_accounts(state: &AppState) -> Vec<ProviderAccount> {
    let prefs = state.provider_prefs().await;
    let clients = state.providers.read().await.clone();
    let users = state.provider_users.read().await.clone();
    let mut out = Vec::new();
    for pref in prefs {
        let Some(client) = clients.get(&pref.id) else { continue };
        let info = crate::providers::available_providers()
            .into_iter()
            .find(|p| p.id == pref.id)
            .unwrap_or_else(|| client.info());
        let authenticated = client.is_authenticated().await;
        out.push(ProviderAccount {
            id: pref.id.clone(),
            name: info.name,
            auth_method: info.auth_method,
            enabled: pref.enabled,
            authenticated,
            user: if authenticated { users.get(&pref.id).cloned() } else { None },
        });
    }
    out
}

// ── OAuth2 Device Flow (Real-Debrid specific) ──

const REAL_DEBRID: &str = "real-debrid";

async fn rd_provider(state: &AppState) -> Result<Arc<dyn DebridProvider>, String> {
    state.provider(REAL_DEBRID).await.ok_or_else(|| "OAuth is only supported for Real-Debrid".to_string())
}

fn get_rd_client(provider: &Arc<dyn DebridProvider>) -> Result<&RdClient, String> {
    provider
        .as_any()
        .downcast_ref::<RdClient>()
        .ok_or_else(|| "OAuth is only supported for Real-Debrid".to_string())
}

pub async fn oauth_start(state: &AppState) -> Result<DeviceCode, String> {
    let provider = rd_provider(state).await?;
    let rd = get_rd_client(&provider)?;
    rd.oauth_device_code().await.map_err(|e| format!("{}", e))
}

pub async fn oauth_poll_credentials(
    state: &AppState,
    secrets: &dyn SecretStore,
    device_code: &str,
) -> Result<Option<DeviceCredentials>, String> {
    let provider = rd_provider(state).await?;
    let rd = get_rd_client(&provider)?;

    match rd.oauth_device_credentials::<DeviceCredentials>(device_code).await {
        Ok(creds) => {
            secrets
                .set(&prefixed_key(REAL_DEBRID, "oauth_client_id"), &creds.client_id)
                .map_err(|e| map_keyring_save_error("client_id", e))?;
            secrets
                .set(&prefixed_key(REAL_DEBRID, "oauth_client_secret"), &creds.client_secret)
                .map_err(|e| map_keyring_save_error("client_secret", e))?;
            Ok(Some(creds))
        }
        Err(_) => Ok(None),
    }
}

/// Finish the device flow: save Real-Debrid's tokens, sign it in, and enable it.
pub async fn oauth_get_token(
    state: &AppState,
    persistence: &Persistence,
    secrets: &dyn SecretStore,
    client_id: &str,
    client_secret: &str,
    device_code: &str,
) -> Result<OAuthToken, String> {
    let provider = rd_provider(state).await?;
    let rd = get_rd_client(&provider)?;

    let token: OAuthToken = rd
        .oauth_token(client_id, client_secret, device_code)
        .await
        .map_err(|e| format!("{}", e))?;

    secrets
        .set(&prefixed_key(REAL_DEBRID, "api_token"), &token.access_token)
        .map_err(|e| map_keyring_save_error("access token", e))?;
    secrets
        .set(&prefixed_key(REAL_DEBRID, "refresh_token"), &token.refresh_token)
        .map_err(|e| map_keyring_save_error("refresh token", e))?;

    rd.set_token(token.access_token.clone()).await;
    match provider.authenticate(&ProviderAuth::Token(token.access_token.clone())).await {
        Ok(user) => {
            state.provider_users.write().await.insert(REAL_DEBRID.to_string(), user);
        }
        Err(e) => log::warn!("Real-Debrid account lookup after OAuth failed: {}", e),
    }
    update_prefs(state, persistence, |prefs| enable(prefs, REAL_DEBRID)).await?;

    Ok(token)
}

// ── Provider management ──

/// Factory function to create a provider by ID.
pub fn create_provider(provider_id: &str) -> Result<Arc<dyn DebridProvider>, String> {
    match provider_id {
        "real-debrid" => Ok(Arc::new(RdClient::new())),
        "torbox" => Ok(Arc::new(crate::providers::torbox::client::TorBoxClient::new())),
        "premiumize" => Ok(Arc::new(crate::providers::premiumize::client::PremiumizeClient::new())),
        "alldebrid" => Ok(Arc::new(crate::providers::alldebrid::client::AllDebridClient::new())),
        _ => Err(format!("Unknown provider: {}", provider_id)),
    }
}

pub fn get_available_providers() -> Vec<ProviderInfo> {
    crate::providers::available_providers()
}

/// Auth method of provider `provider_id` (the primary one when `None`).
pub async fn get_auth_method(state: &AppState, provider_id: Option<&str>) -> Result<AuthMethod, String> {
    let (id, provider) = state.provider_for(provider_id).await?;
    Ok(crate::providers::available_providers()
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.auth_method)
        .unwrap_or_else(|| provider.info().auth_method))
}

/// Move `provider_id` to the top of the priority list and enable it, persist that, and try its
/// saved token. Returns whether the provider is signed in.
pub async fn switch_provider(
    state: &AppState,
    persistence: &Persistence,
    secrets: &dyn SecretStore,
    provider_id: &str,
) -> Result<bool, String> {
    create_provider(provider_id)?;
    update_prefs(state, persistence, |prefs| {
        if let Some(i) = prefs.iter().position(|p| p.id == provider_id) {
            let mut pref = prefs.remove(i);
            pref.enabled = true;
            prefs.insert(0, pref);
        }
    })
    .await?;

    let provider = state.provider_for(Some(provider_id)).await?.1;
    if provider.is_authenticated().await {
        return Ok(true);
    }
    // Try to load saved credentials
    if let Ok(Some(token)) = secrets.get(&prefixed_key(provider_id, "api_token")) {
        if let Ok(user) = provider.authenticate(&ProviderAuth::Token(token)).await {
            state.provider_users.write().await.insert(provider_id.to_string(), user);
            return Ok(true);
        }
    }
    Ok(false)
}

/// The primary provider (see `AppState::primary_provider_id`).
pub async fn get_active_provider(state: &AppState) -> String {
    state.primary_provider_id().await
}

#[cfg(test)]
mod tests {
    use super::create_provider;

    #[test]
    fn every_available_provider_can_be_created() {
        for info in crate::providers::available_providers() {
            let provider = create_provider(&info.id).unwrap_or_else(|e| panic!("{}: {}", info.id, e));
            assert_eq!(provider.info().id, info.id);
        }
        assert_eq!(create_provider("alldebrid").unwrap().info().name, "AllDebrid");
        assert!(create_provider("nope").is_err());
    }
}
