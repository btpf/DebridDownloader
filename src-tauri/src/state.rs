use crate::providers::types::User;
use crate::providers::DebridProvider;
use crate::watchlist::{WatchMatch, WatchRule};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

pub use crate::engine::types::JobState as DownloadStatus;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub download_folder: Option<String>,
    pub max_concurrent_downloads: u32,
    pub create_torrent_subfolders: bool,
    pub theme: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub symlink_mode: bool,
    #[serde(default)]
    pub symlink_mount_path: Option<String>,
    #[serde(default)]
    pub symlink_library_path: Option<String>,
    #[serde(default)]
    pub auto_organize: bool,
    #[serde(default)]
    pub movies_folder: Option<String>,
    #[serde(default)]
    pub tv_folder: Option<String>,
    #[serde(default)]
    pub tmdb_api_key: Option<String>,
    #[serde(default)]
    pub plex_url: Option<String>,
    #[serde(default)]
    pub plex_token: Option<String>,
    #[serde(default)]
    pub jellyfin_url: Option<String>,
    #[serde(default)]
    pub jellyfin_api_key: Option<String>,
    #[serde(default)]
    pub emby_url: Option<String>,
    #[serde(default)]
    pub emby_api_key: Option<String>,
    #[serde(default)]
    pub speed_limit_bytes: Option<u64>,
    #[serde(default)]
    pub auto_extract_archives: bool,
    #[serde(default)]
    pub delete_archives_after_extract: bool,
    /// Ignored: TorBox retired its Search API (#92). Kept so older persisted blobs still load.
    #[serde(default)]
    pub torbox_search_enabled: bool,
    #[serde(default = "default_segments")]
    pub segments_per_file: u32,
    /// Every provider in priority order, each enabled or not. Empty in blobs saved before
    /// multi-provider support: [`AppSettings::provider_prefs`] then derives it from `provider`.
    #[serde(default)]
    pub providers: Vec<ProviderPref>,
    /// Add a torrent to every enabled, signed-in provider at once instead of only the first
    /// one (in priority order) that accepts it.
    #[serde(default)]
    pub add_to_all_providers: bool,
}

/// One provider's place in the priority list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderPref {
    pub id: String,
    pub enabled: bool,
}

fn default_provider() -> String {
    "real-debrid".to_string()
}

fn default_segments() -> u32 {
    4
}

impl AppSettings {
    /// The priority list with every known provider exactly once. Unknown ids and duplicates are
    /// dropped; providers missing from the list are appended, disabled. A blob from before
    /// multi-provider support has no list, so its single `provider` becomes the first, enabled.
    pub fn provider_prefs(&self) -> Vec<ProviderPref> {
        let known: Vec<String> = crate::providers::available_providers().into_iter().map(|p| p.id).collect();
        let mut out: Vec<ProviderPref> = Vec::new();
        for pref in &self.providers {
            if known.contains(&pref.id) && !out.iter().any(|p| p.id == pref.id) {
                out.push(pref.clone());
            }
        }
        if out.is_empty() {
            let legacy = if known.contains(&self.provider) { self.provider.clone() } else { default_provider() };
            out.push(ProviderPref { id: legacy, enabled: true });
        }
        for id in known {
            if !out.iter().any(|p| p.id == id) {
                out.push(ProviderPref { id, enabled: false });
            }
        }
        out
    }

    /// Store the full priority list and keep the legacy `provider` field on the first enabled
    /// provider, so an older build reading this blob still finds a sensible one.
    pub fn normalize_providers(&mut self) {
        self.providers = self.provider_prefs();
        if let Some(first) = self.providers.iter().find(|p| p.enabled).or(self.providers.first()) {
            self.provider = first.id.clone();
        }
    }

    pub fn engine_config(&self, rar_tool: crate::extractor::RarTool) -> crate::engine::EngineConfig {
        crate::engine::EngineConfig {
            max_concurrent: self.max_concurrent_downloads.max(1),
            segments_per_file: self.segments_per_file.clamp(1, 16),
            speed_limit_bytes: self.speed_limit_bytes,
            post: crate::engine::PostConfig {
                auto_extract: self.auto_extract_archives,
                delete_after_extract: self.delete_archives_after_extract,
                auto_organize: self.auto_organize,
                movies_folder: self.movies_folder.clone(),
                tv_folder: self.tv_folder.clone(),
                tmdb_api_key: self.tmdb_api_key.clone(),
                rar_tool,
            },
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            download_folder: None,
            max_concurrent_downloads: 3,
            create_torrent_subfolders: true,
            theme: "dark".to_string(),
            provider: default_provider(),
            symlink_mode: false,
            symlink_mount_path: None,
            symlink_library_path: None,
            auto_organize: false,
            movies_folder: None,
            tv_folder: None,
            tmdb_api_key: None,
            plex_url: None,
            plex_token: None,
            jellyfin_url: None,
            jellyfin_api_key: None,
            emby_url: None,
            emby_api_key: None,
            speed_limit_bytes: None,
            auto_extract_archives: false,
            delete_archives_after_extract: false,
            torbox_search_enabled: false,
            segments_per_file: default_segments(),
            providers: Vec::new(),
            add_to_all_providers: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub destination: String,
    pub total_bytes: i64,
    pub downloaded_bytes: i64,
    pub speed: f64,
    pub status: DownloadStatus,
    #[serde(default)]
    pub remote: Option<String>,
}

pub struct StreamSession {
    pub url: String,
    pub created_at: Instant,
}

/// How often a provider took a torrent (`hits`) or refused it (`misses`) when one was added.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ProviderStat {
    #[serde(default)]
    pub hits: u64,
    #[serde(default)]
    pub misses: u64,
}

pub struct AppState {
    /// One client per provider id, signed in or not. Order and enabled flags live in
    /// `settings.providers`.
    pub providers: Arc<RwLock<HashMap<String, Arc<dyn DebridProvider>>>>,
    /// The account each signed-in provider answered with when its token was last checked.
    pub provider_users: Arc<RwLock<HashMap<String, User>>>,
    /// Add hits/misses per provider id (see `service::stats`).
    pub provider_stats: Arc<RwLock<HashMap<String, ProviderStat>>>,
    /// Where `provider_stats` is saved; set at startup by `service::stats::load`.
    pub stats_store: std::sync::OnceLock<crate::persistence::Persistence>,
    pub settings: Arc<RwLock<AppSettings>>,
    pub engine: std::sync::OnceLock<crate::engine::Engine>,
    pub streaming_port: Arc<RwLock<Option<u16>>>,
    pub stream_sessions: Arc<RwLock<HashMap<String, StreamSession>>>,
    pub watch_rules: Arc<RwLock<Vec<WatchRule>>>,
    pub watch_matches: Arc<RwLock<Vec<WatchMatch>>>,
    pub watch_seen: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    pub watch_cancel: CancellationToken,
    pub rar_tool: crate::extractor::RarTool,
}

impl AppState {
    pub fn new() -> Self {
        let providers = crate::providers::available_providers()
            .into_iter()
            .filter_map(|info| crate::service::auth::create_provider(&info.id).ok().map(|p| (info.id, p)))
            .collect();
        Self {
            providers: Arc::new(RwLock::new(providers)),
            provider_users: Arc::new(RwLock::new(HashMap::new())),
            provider_stats: Arc::new(RwLock::new(HashMap::new())),
            stats_store: std::sync::OnceLock::new(),
            settings: Arc::new(RwLock::new(AppSettings::default())),
            engine: std::sync::OnceLock::new(),
            streaming_port: Arc::new(RwLock::new(None)),
            stream_sessions: Arc::new(RwLock::new(HashMap::new())),
            watch_rules: Arc::new(RwLock::new(Vec::new())),
            watch_matches: Arc::new(RwLock::new(Vec::new())),
            watch_seen: Arc::new(RwLock::new(HashMap::new())),
            watch_cancel: CancellationToken::new(),
            rar_tool: crate::extractor::detect_rar_tool(),
        }
    }

    /// The client for provider `id` (signed in or not). Clones the `Arc`; no lock is held after.
    pub async fn provider(&self, id: &str) -> Option<Arc<dyn DebridProvider>> {
        self.providers.read().await.get(id).cloned()
    }

    /// Replace the client for provider `id` (a fresh one on sign-out; a fake in tests).
    pub async fn install_provider(&self, id: &str, provider: Arc<dyn DebridProvider>) {
        self.providers.write().await.insert(id.to_string(), provider);
    }

    /// The priority list (see [`AppSettings::provider_prefs`]).
    pub async fn provider_prefs(&self) -> Vec<ProviderPref> {
        self.settings.read().await.provider_prefs()
    }

    /// Enabled, signed-in providers in priority order.
    pub async fn active_providers(&self) -> Vec<(String, Arc<dyn DebridProvider>)> {
        let prefs = self.provider_prefs().await;
        let clients = self.providers.read().await.clone();
        let mut out = Vec::new();
        for pref in prefs.into_iter().filter(|p| p.enabled) {
            if let Some(client) = clients.get(&pref.id) {
                if client.is_authenticated().await {
                    out.push((pref.id, client.clone()));
                }
            }
        }
        out
    }

    /// The provider that answers when a caller doesn't name one: the first enabled, signed-in
    /// provider, else the first enabled one, else the first in the list.
    pub async fn primary_provider_id(&self) -> String {
        if let Some((id, _)) = self.active_providers().await.into_iter().next() {
            return id;
        }
        let prefs = self.provider_prefs().await;
        prefs
            .iter()
            .find(|p| p.enabled)
            .or(prefs.first())
            .map(|p| p.id.clone())
            .unwrap_or_else(default_provider)
    }

    /// The primary provider's client (see [`AppState::primary_provider_id`]).
    /// Clones the `Arc`; never hold the `RwLock` across async operations.
    pub async fn get_provider(&self) -> Arc<dyn DebridProvider> {
        let id = self.primary_provider_id().await;
        match self.provider(&id).await {
            Some(p) => p,
            None => crate::service::auth::create_provider(&default_provider()).expect("real-debrid exists"),
        }
    }

    /// Provider `id`, or the primary one when `id` is `None` or empty. Errors on an unknown id.
    pub async fn provider_for(&self, id: Option<&str>) -> Result<(String, Arc<dyn DebridProvider>), String> {
        let id = match id.filter(|s| !s.is_empty()) {
            Some(id) => id.to_string(),
            None => self.primary_provider_id().await,
        };
        let provider = self.provider(&id).await.ok_or_else(|| format!("Unknown provider: {}", id))?;
        Ok((id, provider))
    }

    pub fn engine(&self) -> Result<crate::engine::Engine, String> {
        self.engine.get().cloned().ok_or_else(|| "Download engine is not running".to_string())
    }
}

/// Reaches the shared [`AppState`] from a long-lived host adapter (engine seams, watch loop):
/// the desktop app implements it for its `AppHandle`, the headless server uses `Arc<AppState>`.
pub trait StateHandle: Send + Sync + 'static {
    fn app_state(&self) -> &AppState;
}

impl StateHandle for Arc<AppState> {
    fn app_state(&self) -> &AppState {
        self
    }
}
