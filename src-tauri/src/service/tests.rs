//! The command bodies run against an `AppState` built without Tauri: a JSON-file store, a file
//! secret store, a fake provider, a real engine, and local HTTP servers for the network.

use super::{auth, downloads, search, settings, torrents, watchlist as watch};
use crate::engine::{self, EngineEvent, EventSink, JobState, LinkRefresher, LinkSource, RefreshError, RefreshedLink};
use crate::events::RecordingEvents;
use crate::persistence::{JsonFileStore, Persistence, SETTINGS_KEY, WATCH_MATCHES_KEY, WATCH_RULES_KEY, WATCH_SEEN_KEY};
use crate::providers::real_debrid::client::RdClient;
use crate::providers::types::*;
use crate::providers::DebridProvider;
use crate::scrapers::TrackerConfig;
use crate::secrets::{FileStore, SecretStore};
use crate::state::{AppSettings, AppState, ProviderPref};
use crate::watchlist::{MatchStatus, RuleType, WatchAction, WatchMatch, WatchRule};
use serde_json::json;
use std::any::Any;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ── Harness ─────────────────────────────────────────────────────────

struct Env {
    state: AppState,
    persistence: Persistence,
    secrets: FileStore,
    dir: tempfile::TempDir,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let persistence = Persistence(Arc::new(JsonFileStore::in_dir(dir.path())));
    // A prefix no real environment sets, so only the file backs the store.
    let secrets = FileStore::with_env_prefix(dir.path().join("secrets.json"), "DD_SERVICE_TEST_NO_ENV_");
    Env { state: AppState::new(), persistence, secrets, dir }
}

impl Env {
    /// Install `provider` as provider `id` and enable it after the ones installed before it.
    async fn with_provider(self, id: &str, provider: Arc<FakeProvider>) -> Self {
        self.state.install_provider(id, provider).await;
        {
            let mut settings = self.state.settings.write().await;
            settings.providers.retain(|p| p.id != id && p.enabled);
            settings.providers.push(ProviderPref { id: id.into(), enabled: true });
            settings.normalize_providers();
        }
        self
    }

    async fn set_add_to_all(&self, on: bool) {
        self.state.settings.write().await.add_to_all_providers = on;
    }

    fn stored(&self, key: &str) -> Option<serde_json::Value> {
        self.persistence.get(key).unwrap()
    }
}

/// Records what the command bodies asked of it; `good_token` is the only token it accepts.
#[derive(Default)]
struct FakeProvider {
    calls: Mutex<Vec<String>>,
    good_token: String,
    selected: Mutex<Option<(String, Vec<u64>)>>,
    /// Adding a torrent fails with this message.
    add_error: Option<String>,
}

impl FakeProvider {
    fn new(good_token: &str) -> Arc<Self> {
        Arc::new(Self { good_token: good_token.into(), ..Default::default() })
    }
    fn failing_adds(message: &str) -> Arc<Self> {
        Arc::new(Self { good_token: "good".into(), add_error: Some(message.into()), ..Default::default() })
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn log(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

fn torrent(id: &str) -> Torrent {
    Torrent {
        id: id.into(),
        filename: "Show".into(),
        hash: "h".into(),
        bytes: 1,
        progress: 100.0,
        status: "downloaded".into(),
        added: String::new(),
        links: vec![],
        ended: None,
        speed: None,
        seeders: None,
        provider: String::new(),
        copies: Vec::new(),
    }
}

#[async_trait::async_trait]
impl DebridProvider for FakeProvider {
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn info(&self) -> ProviderInfo {
        ProviderInfo { id: "fake".into(), name: "Fake".into(), auth_method: AuthMethod::ApiKey, supports_streaming: false }
    }
    async fn authenticate(&self, auth: &ProviderAuth) -> Result<User, ProviderError> {
        match auth {
            ProviderAuth::Token(t) if *t == self.good_token => {
                self.log(format!("authenticate:{}", t));
                Ok(User { username: "u".into(), email: "e".into(), premium: true, expiration: None })
            }
            _ => Err(ProviderError::Api { message: "Bad token".into(), code: None }),
        }
    }
    async fn is_authenticated(&self) -> bool {
        true
    }
    async fn list_torrents(&self, page: u32, limit: u32) -> Result<Vec<Torrent>, ProviderError> {
        self.log(format!("list:{}:{}", page, limit));
        Ok(vec![torrent("t1")])
    }
    async fn torrent_info(&self, id: &str) -> Result<TorrentInfo, ProviderError> {
        Err(ProviderError::Other(format!("no info for {}", id)))
    }
    async fn add_magnet(&self, magnet: &str) -> Result<AddTorrentResponse, ProviderError> {
        self.log(format!("magnet:{}", magnet));
        if let Some(e) = &self.add_error {
            return Err(ProviderError::Other(e.clone()));
        }
        Ok(AddTorrentResponse { id: "new".into(), provider: String::new() })
    }
    async fn add_torrent_file(&self, bytes: &[u8]) -> Result<AddTorrentResponse, ProviderError> {
        self.log(format!("file:{}", bytes.len()));
        if let Some(e) = &self.add_error {
            return Err(ProviderError::Other(e.clone()));
        }
        Ok(AddTorrentResponse { id: "file".into(), provider: String::new() })
    }
    async fn select_files(&self, id: &str, file_ids: &[u64]) -> Result<(), ProviderError> {
        *self.selected.lock().unwrap() = Some((id.into(), file_ids.to_vec()));
        Ok(())
    }
    async fn delete_torrent(&self, id: &str) -> Result<(), ProviderError> {
        self.log(format!("delete:{}", id));
        Ok(())
    }
    async fn get_download_links(&self, id: &str) -> Result<Vec<DownloadLink>, ProviderError> {
        self.log(format!("links:{}", id));
        Ok(vec![])
    }
    async fn get_download_link_for_file(&self, torrent_id: &str, file_id: u64) -> Result<DownloadLink, ProviderError> {
        self.log(format!("link:{}:{}", torrent_id, file_id));
        Ok(DownloadLink {
            filename: format!("f{}", file_id),
            filesize: 1,
            download: "http://x".into(),
            streamable: None,
            source: LinkSource::Direct,
        })
    }
    async fn refresh_link(&self, _source: &LinkSource) -> Result<DownloadLink, ProviderError> {
        Err(ProviderError::Other("no refresh".into()))
    }
    async fn download_history(&self, page: u32, limit: u32) -> Result<Vec<DownloadItem>, ProviderError> {
        self.log(format!("history:{}:{}", page, limit));
        Ok(vec![])
    }
    async fn check_availability(&self, hashes: &[String]) -> Result<Vec<String>, ProviderError> {
        Ok(hashes.iter().filter(|h| h.starts_with('c')).cloned().collect())
    }
}

/// Serve `router` on a random local port; returns its base URL.
async fn serve(router: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    format!("http://{}", addr)
}

// ── Settings ────────────────────────────────────────────────────────

#[tokio::test]
async fn update_settings_persists_blob_and_updates_state() {
    let env = env();
    assert_eq!(settings::get_settings(&env.state).await.max_concurrent_downloads, 3);

    let mut s = AppSettings::default();
    s.download_folder = Some("/downloads".into());
    s.max_concurrent_downloads = 5;
    settings::update_settings(&env.state, &env.persistence, s).await.unwrap();

    let current = settings::get_settings(&env.state).await;
    assert_eq!(current.download_folder.as_deref(), Some("/downloads"));
    assert_eq!(current.max_concurrent_downloads, 5);
    let stored: AppSettings = serde_json::from_value(env.stored(SETTINGS_KEY).unwrap()).unwrap();
    assert_eq!(stored.max_concurrent_downloads, 5);
    // The file the headless host would reuse holds it too.
    let on_disk: serde_json::Value =
        serde_json::from_slice(&std::fs::read(env.dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(on_disk[SETTINGS_KEY]["download_folder"], "/downloads");
}

#[tokio::test]
async fn update_settings_does_not_apply_when_persisting_fails() {
    let env = env();
    std::fs::write(env.dir.path().join("settings.json"), "not json").unwrap();
    let mut s = AppSettings::default();
    s.theme = "light".into();
    assert!(settings::update_settings(&env.state, &env.persistence, s).await.is_err());
    assert_eq!(settings::get_settings(&env.state).await.theme, "dark");
}

// ── Auth ────────────────────────────────────────────────────────────

#[tokio::test]
async fn set_api_token_saves_only_a_validated_token_under_the_provider_key() {
    let env = env().with_provider("torbox", FakeProvider::new("good")).await;

    let set = |token: &str, provider: Option<&'static str>| {
        auth::set_api_token(&env.state, &env.persistence, &env.secrets, token.into(), provider)
    };

    let err = set("bad", None).await.unwrap_err();
    assert_eq!(err, "Bad token");
    assert_eq!(env.secrets.get("torbox.api_token").unwrap(), None);
    assert!(!auth::load_saved_token(&env.state, &env.secrets).await.unwrap());
    assert_eq!(auth::get_user(&env.state, &env.secrets, None).await.unwrap_err(), "No saved token");

    set("good", None).await.unwrap();
    assert_eq!(env.secrets.get("torbox.api_token").unwrap().as_deref(), Some("good"));
    assert!(auth::load_saved_token(&env.state, &env.secrets).await.unwrap());
    assert_eq!(auth::get_user(&env.state, &env.secrets, None).await.unwrap().username, "u");
    assert_eq!(auth::get_user(&env.state, &env.secrets, Some("torbox")).await.unwrap().username, "u");
    assert!(auth::is_authenticated(&env.state).await);
    assert_eq!(auth::get_auth_method(&env.state, None).await, Ok(AuthMethod::ApiKey));
    assert_eq!(auth::get_auth_method(&env.state, Some("real-debrid")).await, Ok(AuthMethod::OAuthDevice));
    assert!(auth::get_auth_method(&env.state, Some("nope")).await.is_err());
}

#[tokio::test]
async fn signing_in_to_a_named_provider_saves_its_token_and_enables_it() {
    let env = env().with_provider("torbox", FakeProvider::new("good")).await;
    env.state.install_provider("alldebrid", FakeProvider::new("ad")).await;
    assert!(!env.state.provider_prefs().await.iter().any(|p| p.id == "alldebrid" && p.enabled));

    auth::set_api_token(&env.state, &env.persistence, &env.secrets, "ad".into(), Some("alldebrid")).await.unwrap();
    assert_eq!(env.secrets.get("alldebrid.api_token").unwrap().as_deref(), Some("ad"));
    assert_eq!(env.secrets.get("torbox.api_token").unwrap(), None);
    let prefs = env.state.provider_prefs().await;
    assert_eq!(prefs[0], ProviderPref { id: "torbox".into(), enabled: true });
    assert!(prefs.iter().any(|p| p.id == "alldebrid" && p.enabled));
    let stored = env.stored(SETTINGS_KEY).unwrap();
    assert!(stored["providers"].as_array().unwrap().iter().any(|p| p["id"] == "alldebrid" && p["enabled"] == true));

    let accounts = auth::get_provider_accounts(&env.state).await;
    assert_eq!(accounts.len(), 4);
    let ad = accounts.iter().find(|a| a.id == "alldebrid").unwrap();
    assert!(ad.enabled && ad.authenticated);
    assert_eq!(ad.name, "AllDebrid");
    assert_eq!(ad.user.as_ref().unwrap().username, "u");
    assert_eq!(accounts[0].id, "torbox");
}

#[tokio::test]
async fn logout_clears_every_credential_and_resets_the_provider() {
    let env = env().with_provider("real-debrid", FakeProvider::new("good")).await;
    for key in ["api_token", "refresh_token", "oauth_client_id", "oauth_client_secret"] {
        env.secrets.set(&format!("real-debrid.{}", key), "v").unwrap();
    }
    env.secrets.set("torbox.api_token", "keep").unwrap();

    auth::logout(&env.state, &env.secrets, Some("real-debrid")).await.unwrap();

    for key in ["api_token", "refresh_token", "oauth_client_id", "oauth_client_secret"] {
        assert_eq!(env.secrets.get(&format!("real-debrid.{}", key)).unwrap(), None, "{}", key);
    }
    assert_eq!(env.secrets.get("torbox.api_token").unwrap().as_deref(), Some("keep"));
    assert!(env.state.provider("real-debrid").await.unwrap().as_any().is::<RdClient>());
    // Still enabled; only signed out.
    assert!(env.state.provider_prefs().await.iter().any(|p| p.id == "real-debrid" && p.enabled));

    // No provider named: every provider is signed out.
    auth::logout(&env.state, &env.secrets, None).await.unwrap();
    assert_eq!(env.secrets.get("torbox.api_token").unwrap(), None);
    assert!(!auth::is_authenticated(&env.state).await);
}

#[tokio::test]
async fn switch_provider_persists_the_choice() {
    let env = env();
    assert_eq!(auth::get_active_provider(&env.state).await, "real-debrid");

    // No saved token, so nothing is authenticated (and no network is touched).
    assert!(!auth::switch_provider(&env.state, &env.persistence, &env.secrets, "premiumize").await.unwrap());
    assert_eq!(auth::get_active_provider(&env.state).await, "premiumize");
    assert_eq!(env.state.get_provider().await.info().id, "premiumize");
    assert_eq!(settings::get_settings(&env.state).await.provider, "premiumize");
    assert_eq!(env.stored(SETTINGS_KEY).unwrap()["provider"], "premiumize");

    assert!(auth::switch_provider(&env.state, &env.persistence, &env.secrets, "nope").await.is_err());
    assert_eq!(auth::get_active_provider(&env.state).await, "premiumize");
    assert_eq!(auth::get_available_providers().len(), 4);
}

#[tokio::test]
async fn oauth_needs_real_debrid() {
    // A Real-Debrid slot that isn't an `RdClient` (no network is touched).
    let env = env().with_provider("real-debrid", FakeProvider::new("good")).await;
    assert_eq!(auth::oauth_start(&env.state).await.unwrap_err(), "OAuth is only supported for Real-Debrid");
    assert!(auth::oauth_poll_credentials(&env.state, &env.secrets, "code").await.is_err());
    assert!(auth::oauth_get_token(&env.state, &env.persistence, &env.secrets, "id", "secret", "code").await.is_err());
}

// ── Torrents ────────────────────────────────────────────────────────

#[tokio::test]
async fn torrent_commands_go_to_the_active_provider() {
    let fake = FakeProvider::new("good");
    let env = env().with_provider("torbox", fake.clone()).await;

    assert_eq!(torrents::list_torrents(&env.state, None, None).await.unwrap()[0].id, "t1");
    torrents::list_torrents(&env.state, Some(2), Some(50)).await.unwrap();
    assert_eq!(torrents::add_magnet(&env.state, "magnet:?xt=urn:btih:abc").await.unwrap().id, "new");
    assert_eq!(torrents::add_torrent_file(&env.state, &[1, 2, 3]).await.unwrap().id, "file");
    torrents::delete_torrent(&env.state, "t1", None).await.unwrap();
    assert_eq!(torrents::get_torrent_info(&env.state, "zz", Some("torbox")).await.unwrap_err(), "no info for zz");

    torrents::select_torrent_files(&env.state, "t1", "3, 1,bad", None).await.unwrap();
    assert_eq!(fake.selected.lock().unwrap().clone(), Some(("t1".to_string(), vec![3, 1])));
    torrents::select_torrent_files(&env.state, "t2", "all", Some("torbox")).await.unwrap();
    assert_eq!(fake.selected.lock().unwrap().clone(), Some(("t2".to_string(), vec![])));

    assert_eq!(
        fake.calls(),
        vec!["list:1:100", "list:2:50", "magnet:magnet:?xt=urn:btih:abc", "file:3", "delete:t1"]
    );
}

#[tokio::test]
async fn adding_falls_back_down_the_priority_list() {
    let first = FakeProvider::failing_adds("Torrent too big");
    let second = FakeProvider::new("good");
    let third = FakeProvider::new("good");
    let env = env()
        .with_provider("torbox", first.clone())
        .await
        .with_provider("alldebrid", second.clone())
        .await
        .with_provider("premiumize", third.clone())
        .await;

    let added = torrents::add_magnet(&env.state, "magnet:?xt=urn:btih:abc").await.unwrap();
    assert_eq!((added.id.as_str(), added.provider.as_str()), ("new", "alldebrid"));
    // Every file is selected where it landed, so the torrent starts.
    assert_eq!(second.selected.lock().unwrap().clone(), Some(("new".to_string(), vec![])));
    assert_eq!(first.calls(), vec!["magnet:magnet:?xt=urn:btih:abc"]);
    assert!(third.calls().is_empty(), "stops at the first provider that takes it");
}

#[tokio::test]
async fn retrying_deletes_each_copy_and_adds_the_magnet_back_to_the_same_provider() {
    let tb = FakeProvider::new("good");
    let ad = FakeProvider::failing_adds("Not cached");
    let env = env().with_provider("torbox", tb.clone()).await.with_provider("alldebrid", ad.clone()).await;
    let hash = "0123456789ABCDEF0123456789abcdef01234567";
    let copy = |p: &str, id: &str| torrents::TorrentRef { provider: p.into(), id: id.into() };

    let added = torrents::retry_torrent(&env.state, hash, &[copy("torbox", "t9")]).await.unwrap();
    assert_eq!((added[0].id.as_str(), added[0].provider.as_str()), ("new", "torbox"));
    assert_eq!(tb.calls(), vec!["delete:t9".to_string(), format!("magnet:magnet:?xt=urn:btih:{}", hash)]);
    assert_eq!(tb.selected.lock().unwrap().clone(), Some(("new".to_string(), vec![])));
    assert!(ad.calls().is_empty(), "only the providers holding a copy are retried");

    let err = torrents::retry_torrent(&env.state, hash, &[copy("torbox", "a"), copy("alldebrid", "b")]).await.unwrap_err();
    assert_eq!(err, "AllDebrid: Not cached");

    for bad in ["", "xyz", "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"] {
        assert!(torrents::retry_torrent(&env.state, bad, &[copy("torbox", "a")]).await.is_err(), "{bad}");
    }
    assert!(torrents::retry_torrent(&env.state, hash, &[]).await.is_err());
}

#[tokio::test]
async fn adding_fails_only_when_every_provider_refuses() {
    let env = env()
        .with_provider("torbox", FakeProvider::failing_adds("Too big"))
        .await
        .with_provider("alldebrid", FakeProvider::failing_adds("Not cached"))
        .await;
    let err = torrents::add_torrent_file(&env.state, &[1]).await.unwrap_err();
    assert_eq!(err, "TorBox: Too big; AllDebrid: Not cached");

    let env = self::env().with_provider("torbox", FakeProvider::failing_adds("Too big")).await;
    assert_eq!(torrents::add_magnet(&env.state, "m").await.unwrap_err(), "Too big");
}

#[tokio::test]
async fn add_to_all_providers_adds_everywhere_and_skips_disabled_ones() {
    let a = FakeProvider::new("good");
    let b = FakeProvider::failing_adds("Not cached");
    let c = FakeProvider::new("good");
    let disabled = FakeProvider::new("good");
    let env = env()
        .with_provider("torbox", a.clone())
        .await
        .with_provider("alldebrid", b.clone())
        .await
        .with_provider("premiumize", c.clone())
        .await;
    env.state.install_provider("real-debrid", disabled.clone()).await;
    env.set_add_to_all(true).await;

    let added = torrents::add_routed(&env.state, torrents::TorrentSource::Magnet("m")).await.unwrap();
    let landed: Vec<&str> = added.iter().map(|a| a.response.provider.as_str()).collect();
    assert_eq!(landed, ["torbox", "premiumize"]);
    assert_eq!(b.calls(), vec!["magnet:m"]);
    assert!(disabled.calls().is_empty());

    let first = torrents::add_magnet(&env.state, "m").await.unwrap();
    assert_eq!(first.provider, "torbox");
    assert_eq!(c.selected.lock().unwrap().clone(), Some(("new".to_string(), vec![])));
}

#[tokio::test]
async fn listing_merges_enabled_providers_and_tags_each_torrent() {
    let env = env()
        .with_provider("torbox", FakeProvider::new("good"))
        .await
        .with_provider("alldebrid", FakeProvider::new("good"))
        .await;
    env.state.install_provider("premiumize", FakeProvider::new("good")).await; // not enabled

    let list = torrents::list_torrents(&env.state, None, None).await.unwrap();
    // Both fakes hold the same torrent (same hash), so it's one row with two copies.
    assert_eq!(list.len(), 1);
    let copies: Vec<&str> = list[0].copies.iter().map(|c| c.provider.as_str()).collect();
    assert_eq!(copies, ["torbox", "alldebrid"]);
    assert_eq!(list[0].provider, "torbox");

    let none = self::env();
    {
        let mut s = none.state.settings.write().await;
        s.providers = vec![ProviderPref { id: "real-debrid".into(), enabled: false }];
    }
    assert!(torrents::list_torrents(&none.state, None, None).await.unwrap_err().contains("No debrid provider"));
}

fn listed(id: &str, name: &str, hash: &str, status: &str) -> Torrent {
    Torrent { filename: name.into(), hash: hash.into(), status: status.into(), ..torrent(id) }
}

#[test]
fn merging_matches_on_the_hash_first_then_on_the_name() {
    let rows = torrents::merge_torrents(vec![
        (
            "real-debrid".into(),
            vec![
                listed("rd1", "Show S01", "ABC", "downloading"),
                listed("rd2", "Movie", "", "downloaded"),
                listed("rd3", "Same Name", "111", "downloaded"),
            ],
        ),
        (
            "alldebrid".into(),
            vec![
                // Same hash, other name and case: same torrent.
                listed("ad1", "show.s01", "abc", "downloaded"),
                // No hash: matched by name (case and spaces ignored).
                listed("ad2", " movie ", "", "downloaded"),
                // Same name, different hash: a different torrent.
                listed("ad3", "Same Name", "222", "downloaded"),
                // A second copy of rd1 on the same provider stays its own row.
                listed("ad4", "Show S01", "abc", "downloaded"),
            ],
        ),
    ]);

    let summary: Vec<(String, Vec<(String, String)>)> = rows
        .iter()
        .map(|r| (r.id.clone(), r.copies.iter().map(|c| (c.provider.clone(), c.id.clone())).collect()))
        .collect();
    let pair = |p: &str, id: &str| (p.to_string(), id.to_string());
    assert_eq!(
        summary,
        vec![
            // rd1 is still downloading, so the row acts on AllDebrid's ready copy.
            ("ad1".to_string(), vec![pair("real-debrid", "rd1"), pair("alldebrid", "ad1")]),
            ("rd2".to_string(), vec![pair("real-debrid", "rd2"), pair("alldebrid", "ad2")]),
            ("rd3".to_string(), vec![pair("real-debrid", "rd3")]),
            ("ad3".to_string(), vec![pair("alldebrid", "ad3")]),
            ("ad4".to_string(), vec![pair("alldebrid", "ad4")]),
        ]
    );
    assert_eq!(rows[0].provider, "alldebrid");
    assert_eq!(rows[0].status, "downloaded");
    assert_eq!(rows[0].copies[0].status, "downloading");
}

#[test]
fn a_merged_row_keeps_a_hash_from_any_copy() {
    let rows = torrents::merge_torrents(vec![
        ("torbox".into(), vec![listed("t1", "Album", "", "downloaded")]),
        ("premiumize".into(), vec![listed("p1", "Album", "FFF", "downloaded")]),
    ]);
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].id.as_str(), rows[0].hash.as_str()), ("t1", "FFF"));
}

#[test]
fn the_close_button_asks_unless_a_choice_was_saved() {
    assert_eq!(AppSettings::default().close_action, "ask");
    // A blob saved before the setting existed still loads, and asks.
    let mut blob = serde_json::to_value(AppSettings::default()).unwrap();
    blob.as_object_mut().unwrap().remove("close_action");
    assert_eq!(serde_json::from_value::<AppSettings>(blob).unwrap().close_action, "ask");
}

#[test]
fn downloads_are_sparse_unless_turned_off() {
    let s = AppSettings::default();
    assert!(s.sparse_downloads);
    assert!(s.engine_config(crate::extractor::RarTool::None).sparse_files);
    // A blob saved before the setting existed still loads, sparse.
    let mut blob = serde_json::to_value(AppSettings::default()).unwrap();
    blob.as_object_mut().unwrap().remove("sparse_downloads");
    assert!(serde_json::from_value::<AppSettings>(blob).unwrap().sparse_downloads);
    let off = AppSettings { sparse_downloads: false, ..AppSettings::default() };
    assert!(!off.engine_config(crate::extractor::RarTool::None).sparse_files);
}

#[test]
fn provider_prefs_come_from_the_legacy_provider_and_stay_complete() {
    let mut legacy = AppSettings { provider: "torbox".into(), ..AppSettings::default() };
    let prefs = legacy.provider_prefs();
    assert_eq!(prefs[0], ProviderPref { id: "torbox".into(), enabled: true });
    assert_eq!(prefs.len(), 4);
    assert!(prefs[1..].iter().all(|p| !p.enabled));

    // Unknown and repeated ids are dropped; missing ones are added, disabled.
    legacy.providers = vec![
        ProviderPref { id: "alldebrid".into(), enabled: true },
        ProviderPref { id: "nope".into(), enabled: true },
        ProviderPref { id: "alldebrid".into(), enabled: false },
        ProviderPref { id: "torbox".into(), enabled: false },
    ];
    legacy.normalize_providers();
    let ids: Vec<&str> = legacy.providers.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["alldebrid", "torbox", "real-debrid", "premiumize"]);
    assert!(legacy.providers[0].enabled && !legacy.providers[1].enabled);
    assert_eq!(legacy.provider, "alldebrid");

    // A blob from before multi-provider support still loads.
    let old: AppSettings = serde_json::from_value(json!({
        "download_folder": null, "max_concurrent_downloads": 3, "create_torrent_subfolders": true,
        "theme": "dark", "provider": "premiumize"
    }))
    .unwrap();
    assert!(!old.add_to_all_providers);
    assert_eq!(old.provider_prefs()[0], ProviderPref { id: "premiumize".into(), enabled: true });
}

#[tokio::test]
async fn links_history_and_cache_go_to_the_active_provider() {
    let fake = FakeProvider::new("good");
    let env = env().with_provider("torbox", fake.clone()).await;

    downloads::unrestrict_torrent_links(&env.state, "t1", None, None).await.unwrap();
    let links = downloads::unrestrict_torrent_links(&env.state, "t1", Some(vec![4, 5]), Some("torbox")).await.unwrap();
    assert_eq!(links.iter().map(|l| l.filename.as_str()).collect::<Vec<_>>(), ["f4", "f5"]);
    downloads::get_download_history(&env.state, None, Some(10)).await.unwrap();
    assert_eq!(fake.calls(), vec!["links:t1", "link:t1:4", "link:t1:5", "history:1:10"]);

    let cached = search::check_cache_availability(&env.state, &["c1".into(), "x2".into()]).await.unwrap();
    assert_eq!(cached, vec!["c1".to_string()]);
}

// ── Downloads ───────────────────────────────────────────────────────

struct NoSink;
impl EventSink for NoSink {
    fn emit(&self, _event: EngineEvent) {}
}

struct NoRefresh;
#[async_trait::async_trait]
impl LinkRefresher for NoRefresh {
    async fn refresh(&self, _source: &LinkSource) -> Result<RefreshedLink, RefreshError> {
        Err(RefreshError::NotRefreshable)
    }
}

fn start_engine(env: &Env) {
    let engine = engine::Engine::start(engine::EngineDeps::new(
        env.dir.path().join("engine"),
        AppSettings::default().engine_config(env.state.rar_tool),
        Arc::new(NoSink),
        Arc::new(NoRefresh),
        Arc::new(engine::NoRemote),
    ));
    assert!(env.state.engine.set(engine).is_ok());
}

#[tokio::test]
async fn download_commands_need_a_running_engine() {
    let env = env();
    assert_eq!(downloads::get_download_tasks(&env.state).await.unwrap_err(), "Download engine is not running");
    assert!(downloads::pause_all_downloads(&env.state).await.is_err());
    let start = downloads::start_downloads(&env.state, Arc::new(RecordingEvents::default()), vec![], "/tmp".into(), None);
    assert!(start.await.is_err());
}

#[tokio::test]
async fn start_downloads_queues_jobs_that_download_into_the_torrent_folder() {
    let body: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
    let served = body.clone();
    let base = serve(axum::Router::new().route("/f", axum::routing::get(move || async move { served.clone() }))).await;

    let env = env();
    start_engine(&env);
    let out = env.dir.path().join("out");
    let link = DownloadLink {
        filename: "ep:1.mkv".into(),
        filesize: body.len() as i64,
        download: format!("{}/f", base),
        streamable: None,
        source: LinkSource::Direct,
    };

    let ids = downloads::start_downloads(
        &env.state,
        Arc::new(RecordingEvents::default()),
        vec![link],
        out.to_string_lossy().to_string(),
        Some("My Show".into()),
    )
    .await
    .unwrap();
    assert_eq!(ids.len(), 1);

    let mut done = None;
    for _ in 0..200 {
        let jobs = downloads::get_download_tasks(&env.state).await.unwrap();
        if let Some(job) = jobs.iter().find(|j| j.id == ids[0] && j.status == JobState::Completed) {
            done = Some(job.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let job = done.expect("download did not complete");
    assert_eq!(job.batch_name, "My Show");
    let dest = out.join("My Show").join("ep_1.mkv");
    assert_eq!(job.destination, dest.to_string_lossy());
    assert_eq!(std::fs::read(&dest).unwrap(), body);

    downloads::clear_completed_downloads(&env.state).await.unwrap();
    for _ in 0..100 {
        if downloads::get_download_tasks(&env.state).await.unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("completed job was not cleared");
}

#[tokio::test]
async fn symlink_mode_without_a_mount_path_is_an_error() {
    let env = env();
    start_engine(&env);
    env.state.settings.write().await.symlink_mode = true;
    let link = DownloadLink {
        filename: "a.mkv".into(),
        filesize: 1,
        download: "http://x".into(),
        streamable: None,
        source: LinkSource::Direct,
    };
    let err = downloads::start_downloads(&env.state, Arc::new(RecordingEvents::default()), vec![link], "/x".into(), None)
        .await
        .unwrap_err();
    assert_eq!(err, "Symlink mode is on but no mount path configured");
}

/// Symlink mode triggers media-server scans; their toasts go through the event seam.
#[cfg(unix)]
#[tokio::test]
async fn symlink_downloads_emit_scan_toasts_through_the_event_seam() {
    let plex = serve(axum::Router::new().route(
        "/library/sections/all/refresh",
        axum::routing::get(|| async { "ok" }),
    ))
    .await;
    let jellyfin = serve(axum::Router::new().route(
        "/Library/Refresh",
        axum::routing::post(|| async { axum::http::StatusCode::INTERNAL_SERVER_ERROR }),
    ))
    .await;

    let env = env();
    start_engine(&env);
    let mount = env.dir.path().join("mount");
    let library = env.dir.path().join("library");
    std::fs::create_dir_all(mount.join("Pack")).unwrap();
    std::fs::write(mount.join("Pack").join("a.mkv"), b"x").unwrap();
    {
        let mut s = env.state.settings.write().await;
        s.symlink_mode = true;
        s.symlink_mount_path = Some(mount.to_string_lossy().to_string());
        s.symlink_library_path = Some(library.to_string_lossy().to_string());
        s.plex_url = Some(plex);
        s.plex_token = Some("tok".into());
        s.jellyfin_url = Some(jellyfin);
        s.jellyfin_api_key = Some("key".into());
    }
    let link = DownloadLink {
        filename: "a.mkv".into(),
        filesize: 1,
        download: "http://x".into(),
        streamable: None,
        source: LinkSource::Direct,
    };
    let events = Arc::new(RecordingEvents::default());
    let ids = downloads::start_downloads(&env.state, events.clone(), vec![link], String::new(), Some("Pack".into()))
        .await
        .unwrap();
    assert_eq!(ids.len(), 1);
    let linked = library.join("Pack").join("a.mkv");
    assert_eq!(std::fs::read_link(&linked).unwrap(), mount.join("Pack").join("a.mkv"));

    for _ in 0..200 {
        if !events.named("toast").is_empty() && !events.named("toast-error").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(events.named("toast"), vec![json!("Plex library scan triggered")]);
    assert_eq!(events.named("toast-error"), vec![json!("Jellyfin scan failed: HTTP 500 Internal Server Error")]);
}

// ── Search ──────────────────────────────────────────────────────────

fn tracker(url: &str) -> TrackerConfig {
    serde_json::from_value(json!({
        "id": "pb", "name": "PB", "url": url, "tracker_type": "piratebay_api", "enabled": true
    }))
    .unwrap()
}

/// A Pirate Bay-style API that returns one result for every query.
async fn tracker_server() -> String {
    serve(axum::Router::new().route(
        "/q.php",
        axum::routing::get(|| async {
            axum::Json(json!([{
                "name": "Show S01E03 1080p",
                "info_hash": "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
                "seeders": "10", "leechers": "1", "size": "1000", "added": "0", "category": "205"
            }]))
        }),
    ))
    .await
}

#[tokio::test]
async fn tracker_configs_round_trip_and_feed_search() {
    let env = env();
    assert!(search::get_tracker_configs(&env.persistence).is_empty());
    let params = || crate::scrapers::SearchParams { query: "show".into(), category: None, sort_by: None, page: None };
    let empty = search::search_torrents(&env.state, &env.persistence, params()).await;
    assert!(empty.results.is_empty());
    assert_eq!(empty.tracker_status[0].name, "No trackers");

    let base = tracker_server().await;
    search::save_tracker_configs(&env.persistence, &[tracker(&base)]).unwrap();
    assert_eq!(search::get_tracker_configs(&env.persistence)[0].url, base);

    let found = search::search_torrents(&env.state, &env.persistence, params()).await;
    assert_eq!(found.results.len(), 1);
    assert_eq!(found.results[0].info_hash, "abcdef0123456789abcdef0123456789abcdef01");
}

/// Issue #92: TorBox retired its Search API. Old blobs with the flag still load, and the flag no
/// longer adds a search source, so a TorBox user with no trackers gets the "No trackers" status.
#[tokio::test]
async fn retired_torbox_search_flag_still_loads_and_adds_no_source() {
    let blob = json!({ "download_folder": null, "max_concurrent_downloads": 3, "create_torrent_subfolders": true, "theme": "dark", "torbox_search_enabled": true });
    let loaded: AppSettings = serde_json::from_value(blob).unwrap();
    assert!(loaded.torbox_search_enabled);

    let env = env().with_provider("torbox", FakeProvider::new("t")).await;
    *env.state.settings.write().await = loaded;
    let params = crate::scrapers::SearchParams { query: "show".into(), category: None, sort_by: None, page: None };
    let resp = search::search_torrents(&env.state, &env.persistence, params).await;
    assert!(resp.results.is_empty());
    assert_eq!(resp.tracker_status.len(), 1);
    assert_eq!(resp.tracker_status[0].name, "No trackers");
    assert!(!std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/scrapers/torbox_search.rs").exists());
}

#[tokio::test]
async fn test_tracker_reports_connected_and_unknown_types() {
    let base = tracker_server().await;
    assert_eq!(search::test_tracker("piratebay_api", &base, None).await.unwrap(), "Connected");
    assert_eq!(search::test_tracker("gopher", &base, None).await.unwrap_err(), "Unknown tracker type: gopher");
}

// ── Watchlist ───────────────────────────────────────────────────────

fn rule(id: &str, regex: Option<&str>) -> WatchRule {
    WatchRule {
        id: id.into(),
        name: id.into(),
        rule_type: RuleType::TvShow { last_season: None, last_episode: None },
        query: "show".into(),
        category: None,
        regex_filter: regex.map(str::to_string),
        min_seeders: None,
        min_size_bytes: None,
        max_size_bytes: None,
        action: WatchAction::Notify,
        interval_minutes: 60,
        enabled: true,
        created_at: String::new(),
        last_checked: None,
    }
}

fn a_match(rule_id: &str, hash: &str) -> WatchMatch {
    WatchMatch {
        rule_id: rule_id.into(),
        info_hash: hash.into(),
        magnet: String::new(),
        title: String::new(),
        size_bytes: 0,
        matched_at: String::new(),
        action_taken: WatchAction::Notify,
        status: MatchStatus::Notified,
        season: None,
        episode: None,
    }
}

#[tokio::test]
async fn watch_rules_are_validated_and_persisted() {
    let env = env();
    let err = watch::add_watch_rule(&env.state, &env.persistence, rule("bad", Some("("))).await.unwrap_err();
    assert!(err.starts_with("Invalid regex"), "{}", err);
    assert!(watch::get_watch_rules(&env.state).await.is_empty());
    assert_eq!(env.stored(WATCH_RULES_KEY), None);

    watch::add_watch_rule(&env.state, &env.persistence, rule("r1", Some(""))).await.unwrap();
    let mut changed = rule("r1", None);
    changed.query = "other".into();
    watch::update_watch_rule(&env.state, &env.persistence, changed).await.unwrap();
    assert_eq!(watch::get_watch_rules(&env.state).await[0].query, "other");
    assert_eq!(env.stored(WATCH_RULES_KEY).unwrap()[0]["query"], "other");

    assert_eq!(
        watch::update_watch_rule(&env.state, &env.persistence, rule("missing", None)).await.unwrap_err(),
        "Rule not found"
    );
    assert!(watch::update_watch_rule(&env.state, &env.persistence, rule("r1", Some("[")))
        .await
        .unwrap_err()
        .starts_with("Invalid regex"));
}

#[tokio::test]
async fn deleting_a_rule_drops_its_matches_and_seen_hashes() {
    let env = env();
    watch::add_watch_rule(&env.state, &env.persistence, rule("r1", None)).await.unwrap();
    watch::add_watch_rule(&env.state, &env.persistence, rule("r2", None)).await.unwrap();
    *env.state.watch_matches.write().await = vec![a_match("r1", "a"), a_match("r2", "b"), a_match("r2", "c")];
    env.state.watch_seen.write().await.insert("r1".into(), ["a".to_string()].into());

    assert_eq!(watch::get_watch_matches(&env.state, Some("r2")).await.len(), 2);
    assert_eq!(watch::get_watch_matches(&env.state, None).await.len(), 3);

    watch::delete_watch_rule(&env.state, &env.persistence, "r1").await.unwrap();
    assert_eq!(watch::get_watch_rules(&env.state).await.len(), 1);
    assert_eq!(watch::get_watch_matches(&env.state, None).await.len(), 2);
    assert!(env.state.watch_seen.read().await.get("r1").is_none());
    assert_eq!(env.stored(WATCH_RULES_KEY).unwrap().as_array().unwrap().len(), 1);
    assert_eq!(env.stored(WATCH_MATCHES_KEY).unwrap().as_array().unwrap().len(), 2);
    assert_eq!(env.stored(WATCH_SEEN_KEY).unwrap(), json!({}));

    watch::clear_watch_matches(&env.state, &env.persistence, Some("r2")).await.unwrap();
    assert!(watch::get_watch_matches(&env.state, None).await.is_empty());
    assert_eq!(env.stored(WATCH_MATCHES_KEY).unwrap(), json!([]));
}

#[tokio::test]
async fn run_watch_rule_now_needs_the_rule_and_trackers() {
    let env = env();
    let events = RecordingEvents::default();
    assert_eq!(
        watch::run_watch_rule_now(&env.state, &env.persistence, &events, "nope").await.unwrap_err(),
        "Rule not found"
    );
    watch::add_watch_rule(&env.state, &env.persistence, rule("r1", None)).await.unwrap();
    assert_eq!(
        watch::run_watch_rule_now(&env.state, &env.persistence, &events, "r1").await.unwrap_err(),
        "No trackers configured"
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    assert!(!crate::watchlist::run_due_rules(&env.state, &env.persistence, &events, &cancel).await);
}

#[tokio::test]
async fn run_watch_rule_now_records_matches_and_emits_them() {
    let env = env();
    search::save_tracker_configs(&env.persistence, &[tracker(&tracker_server().await)]).unwrap();
    watch::add_watch_rule(&env.state, &env.persistence, rule("r1", None)).await.unwrap();
    let events = RecordingEvents::default();

    let found = watch::run_watch_rule_now(&env.state, &env.persistence, &events, "r1").await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].season, found[0].episode), (Some(1), Some(3)));
    let emitted = events.named("watchlist-match");
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0]["info_hash"], "abcdef0123456789abcdef0123456789abcdef01");

    let rules = watch::get_watch_rules(&env.state).await;
    assert_eq!(rules[0].rule_type, RuleType::TvShow { last_season: Some(1), last_episode: Some(3) });
    assert!(rules[0].last_checked.is_some());
    assert_eq!(env.stored(WATCH_MATCHES_KEY).unwrap().as_array().unwrap().len(), 1);
    assert_eq!(env.stored(WATCH_SEEN_KEY).unwrap()["r1"], json!(["abcdef0123456789abcdef0123456789abcdef01"]));

    // Already seen: a second run finds nothing new and emits nothing.
    assert!(watch::run_watch_rule_now(&env.state, &env.persistence, &events, "r1").await.unwrap().is_empty());
    assert_eq!(events.named("watchlist-match").len(), 1);
}

#[tokio::test]
async fn watch_loop_tick_runs_due_rules_without_tauri() {
    let env = env();
    search::save_tracker_configs(&env.persistence, &[tracker(&tracker_server().await)]).unwrap();
    watch::add_watch_rule(&env.state, &env.persistence, rule("due", None)).await.unwrap();
    let mut off = rule("off", None);
    off.enabled = false;
    watch::add_watch_rule(&env.state, &env.persistence, off).await.unwrap();
    let events = RecordingEvents::default();
    let cancel = tokio_util::sync::CancellationToken::new();

    assert!(crate::watchlist::run_due_rules(&env.state, &env.persistence, &events, &cancel).await);
    let emitted = events.named("watchlist-match");
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0]["rule_id"], "due");
    let rules = watch::get_watch_rules(&env.state).await;
    assert!(rules.iter().find(|r| r.id == "due").unwrap().last_checked.is_some());
    assert!(rules.iter().find(|r| r.id == "off").unwrap().last_checked.is_none());
}

// ── Shape ───────────────────────────────────────────────────────────

/// The command bodies must stay callable without a Tauri runtime.
#[test]
fn service_and_event_seam_are_tauri_free() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<_> = std::fs::read_dir(src.join("service"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().is_some_and(|n| n != "tests.rs"))
        .collect();
    files.push(src.join("events.rs"));
    for path in files {
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("tauri::") && !text.contains("use tauri"), "{} uses tauri", path.display());
    }
}

/// Every Tauri command in the moved domains is a thin wrapper over its `service` function.
#[test]
fn moved_commands_delegate_to_the_service() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands");
    for domain in ["auth", "backup", "downloads", "search", "settings", "torrents", "watchlist"] {
        let text = std::fs::read_to_string(dir.join(format!("{}.rs", domain))).unwrap();
        let commands: Vec<&str> = text.split("#[tauri::command]").skip(1).collect();
        assert!(!commands.is_empty(), "{}", domain);
        for cmd in commands {
            let name = cmd.split("fn ").nth(1).and_then(|s| s.split('(').next()).unwrap_or("?");
            let body = &cmd[cmd.find('{').unwrap()..];
            assert!(body.contains(&format!("svc::{}(", name)), "commands::{}::{} does not call svc::{}", domain, name, name);
            assert!(body.lines().filter(|l| !l.trim().is_empty()).count() <= 4, "commands::{}::{} is not thin", domain, name);
        }
    }
}
