use crate::providers::types::{AddTorrentResponse, Torrent, TorrentCopy, TorrentInfo};
use crate::providers::DebridProvider;
use crate::state::AppState;
use std::sync::Arc;

/// Torrents of every enabled, signed-in provider, merged across providers (see [`merge_torrents`]).
/// Providers are asked concurrently; one that fails is logged and left out, unless they all fail.
pub async fn list_torrents(state: &AppState, page: Option<u32>, limit: Option<u32>) -> Result<Vec<Torrent>, String> {
    let active = state.active_providers().await;
    if active.is_empty() {
        return Err(NO_PROVIDER.to_string());
    }
    let (page, limit) = (page.unwrap_or(1), limit.unwrap_or(100));
    let results = futures::future::join_all(active.iter().map(|(id, p)| async move {
        (id.clone(), p.list_torrents(page, limit).await)
    }))
    .await;
    let mut lists = Vec::new();
    let mut errors = Vec::new();
    for (id, result) in results {
        match result {
            Ok(list) => lists.push((id, list)),
            Err(e) => {
                log::warn!("Listing {} torrents failed: {}", id, e);
                errors.push(format!("{}: {}", provider_name(&id), e));
            }
        }
    }
    if lists.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(merge_torrents(lists))
}

fn normalized_hash(t: &Torrent) -> Option<String> {
    let h = t.hash.trim().to_ascii_lowercase();
    (!h.is_empty()).then_some(h)
}

fn normalized_name(t: &Torrent) -> String {
    t.filename.trim().to_lowercase()
}

/// One row per torrent across providers. `lists` comes in priority order. A torrent joins an
/// existing row when the info hashes match; failing that, when the names match and the hashes
/// don't contradict (one side has none). A row never holds two copies from the same provider.
///
/// Each row lists every copy in priority order in `copies`. Its own fields (`id`, `provider`,
/// `status`, ...) are those of the copy to act on: the first one that's ready to download, else
/// the first one.
pub fn merge_torrents(lists: Vec<(String, Vec<Torrent>)>) -> Vec<Torrent> {
    let mut groups: Vec<Vec<Torrent>> = Vec::new();
    for (provider, list) in lists {
        for mut t in list {
            t.provider = provider.clone();
            let hash = normalized_hash(&t);
            let free = |g: &Vec<Torrent>| !g.iter().any(|c| c.provider == provider);
            let by_hash = hash.as_ref().and_then(|h| {
                groups.iter().position(|g| free(g) && g.iter().any(|c| normalized_hash(c).as_ref() == Some(h)))
            });
            let by_name = || {
                let name = normalized_name(&t);
                groups.iter().position(|g| {
                    free(g)
                        && g.iter().any(|c| normalized_name(c) == name)
                        && match (&hash, g.iter().find_map(normalized_hash)) {
                            (Some(a), Some(b)) => *a == b,
                            _ => true,
                        }
                })
            };
            match by_hash.or_else(by_name) {
                Some(i) => groups[i].push(t),
                None => groups.push(vec![t]),
            }
        }
    }
    groups
        .into_iter()
        .map(|copies| {
            let best = copies.iter().position(|c| c.status == "downloaded").unwrap_or(0);
            let mut row = copies[best].clone();
            if row.hash.is_empty() {
                if let Some(h) = copies.iter().find(|c| !c.hash.is_empty()) {
                    row.hash = h.hash.clone();
                }
            }
            row.copies = copies
                .iter()
                .map(|c| TorrentCopy {
                    provider: c.provider.clone(),
                    id: c.id.clone(),
                    status: c.status.clone(),
                    progress: c.progress,
                })
                .collect();
            row
        })
        .collect()
}

pub async fn get_torrent_info(state: &AppState, id: &str, provider: Option<&str>) -> Result<TorrentInfo, String> {
    let (provider_id, provider) = state.provider_for(provider).await?;
    let mut info = provider.torrent_info(id).await.map_err(|e| format!("{}", e))?;
    info.provider = provider_id;
    Ok(info)
}

/// What a torrent was added from.
#[derive(Clone, Copy)]
pub enum TorrentSource<'a> {
    Magnet(&'a str),
    File(&'a [u8]),
}

async fn add_to(provider: &Arc<dyn DebridProvider>, source: TorrentSource<'_>) -> Result<AddTorrentResponse, String> {
    match source {
        TorrentSource::Magnet(m) => provider.add_magnet(m).await,
        TorrentSource::File(b) => provider.add_torrent_file(b).await,
    }
    .map_err(|e| format!("{}", e))
}

/// One provider a torrent landed on.
pub struct Added {
    pub response: AddTorrentResponse,
    pub provider: Arc<dyn DebridProvider>,
}

const NO_PROVIDER: &str = "No debrid provider is enabled and signed in. Sign in under Settings → Account.";

fn provider_name(id: &str) -> String {
    crate::providers::available_providers()
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.name)
        .unwrap_or_else(|| id.to_string())
}

/// Add a torrent following the account settings: to every enabled, signed-in provider at once
/// when `add_to_all_providers` is on, otherwise to the first one in priority order that accepts
/// it, falling back down the list on failure. Returns where it landed, in priority order.
/// Errors only when no provider took it.
pub async fn add_routed(state: &AppState, source: TorrentSource<'_>) -> Result<Vec<Added>, String> {
    let active = state.active_providers().await;
    if active.is_empty() {
        return Err(NO_PROVIDER.to_string());
    }
    let to_all = state.settings.read().await.add_to_all_providers;
    let mut added = Vec::new();
    let mut errors = Vec::new();
    if to_all {
        let results = futures::future::join_all(active.iter().map(|(_, p)| add_to(p, source))).await;
        for ((id, provider), result) in active.into_iter().zip(results) {
            match result {
                Ok(mut response) => {
                    response.provider = id;
                    added.push(Added { response, provider });
                }
                Err(e) => errors.push((id, e)),
            }
        }
    } else {
        for (id, provider) in active {
            match add_to(&provider, source).await {
                Ok(mut response) => {
                    response.provider = id;
                    added.push(Added { response, provider });
                    break;
                }
                Err(e) => errors.push((id, e)),
            }
        }
    }
    for (id, e) in &errors {
        log::warn!("Adding the torrent to {} failed: {}", id, e);
    }
    if added.is_empty() {
        let only_one = errors.len() == 1;
        return Err(errors
            .into_iter()
            .map(|(id, e)| if only_one { e } else { format!("{}: {}", provider_name(&id), e) })
            .collect::<Vec<_>>()
            .join("; "));
    }
    Ok(added)
}

/// Add a torrent (see [`add_routed`]) and select every file on each provider it landed on, so it
/// starts right away. A failed selection is logged, not returned: the torrent then waits for a
/// file selection in the Torrents inspector. Returns the highest-priority landing.
async fn add_and_select_all(state: &AppState, source: TorrentSource<'_>) -> Result<AddTorrentResponse, String> {
    let added = add_routed(state, source).await?;
    let selections = futures::future::join_all(added.iter().map(|a| a.provider.select_files(&a.response.id, &[]))).await;
    for (a, result) in added.iter().zip(selections) {
        if let Err(e) = result {
            log::warn!("Selecting the files of {} on {} failed: {}", a.response.id, a.response.provider, e);
        }
    }
    Ok(added.into_iter().next().map(|a| a.response).expect("add_routed returns at least one"))
}

pub async fn add_magnet(state: &AppState, magnet: &str) -> Result<AddTorrentResponse, String> {
    add_and_select_all(state, TorrentSource::Magnet(magnet)).await
}

pub async fn add_torrent_file(state: &AppState, file_bytes: &[u8]) -> Result<AddTorrentResponse, String> {
    add_and_select_all(state, TorrentSource::File(file_bytes)).await
}

/// `file_ids` is `"all"` or a comma-separated id list; unparsable ids are skipped.
pub fn parse_file_ids(file_ids: &str) -> Vec<u64> {
    if file_ids == "all" {
        vec![]
    } else {
        file_ids.split(',').filter_map(|s| s.trim().parse().ok()).collect()
    }
}

pub async fn select_torrent_files(state: &AppState, id: &str, file_ids: &str, provider: Option<&str>) -> Result<(), String> {
    let ids = parse_file_ids(file_ids);
    let provider = state.provider_for(provider).await?.1;
    provider.select_files(id, &ids).await.map_err(|e| format!("{}", e))
}

pub async fn delete_torrent(state: &AppState, id: &str, provider: Option<&str>) -> Result<(), String> {
    let provider = state.provider_for(provider).await?.1;
    provider.delete_torrent(id).await.map_err(|e| format!("{}", e))
}
