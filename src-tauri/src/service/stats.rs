//! Per-provider add statistics: how often each provider took a torrent (a hit) or refused it
//! (a miss). Counted in [`crate::service::torrents::add_routed`], kept in
//! [`AppState::provider_stats`] and saved under [`PROVIDER_STATS_KEY`].

use crate::persistence::{Persistence, PROVIDER_STATS_KEY};
use crate::state::{AppState, ProviderStat};
use serde::Serialize;
use std::collections::HashMap;

/// One provider's counts, as the Statistics page shows them.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProviderStats {
    pub provider: String,
    pub name: String,
    pub hits: u64,
    pub misses: u64,
}

/// Load the saved counts into `state` and remember `persistence` so new counts get saved.
pub async fn load(state: &AppState, persistence: &Persistence) {
    if let Ok(Some(val)) = persistence.get(PROVIDER_STATS_KEY) {
        match serde_json::from_value::<HashMap<String, ProviderStat>>(val) {
            Ok(stats) => *state.provider_stats.write().await = stats,
            Err(e) => log::warn!("Ignoring unreadable provider stats: {}", e),
        }
    }
    let _ = state.stats_store.set(persistence.clone());
}

/// Count one add: a hit for each provider in `hits`, a miss for each in `misses`.
/// Saving is best effort; a failure is logged.
pub async fn record_add(state: &AppState, hits: &[String], misses: &[String]) {
    if hits.is_empty() && misses.is_empty() {
        return;
    }
    let snapshot = {
        let mut stats = state.provider_stats.write().await;
        for id in hits {
            stats.entry(id.clone()).or_default().hits += 1;
        }
        for id in misses {
            stats.entry(id.clone()).or_default().misses += 1;
        }
        stats.clone()
    };
    if let Some(store) = state.stats_store.get() {
        if let Err(e) = store.set_json(PROVIDER_STATS_KEY, &snapshot) {
            log::warn!("Saving provider stats failed: {}", e);
        }
    }
}

/// Every provider's counts, in the account priority order (providers never used have zeros).
pub async fn get_provider_stats(state: &AppState) -> Vec<ProviderStats> {
    let prefs = state.provider_prefs().await;
    let stats = state.provider_stats.read().await;
    let names: HashMap<String, String> =
        crate::providers::available_providers().into_iter().map(|p| (p.id, p.name)).collect();
    prefs
        .into_iter()
        .map(|p| {
            let s = stats.get(&p.id).cloned().unwrap_or_default();
            ProviderStats {
                name: names.get(&p.id).cloned().unwrap_or_else(|| p.id.clone()),
                provider: p.id,
                hits: s.hits,
                misses: s.misses,
            }
        })
        .collect()
}

/// Zero every count.
pub async fn reset_provider_stats(state: &AppState, persistence: &Persistence) -> Result<(), String> {
    state.provider_stats.write().await.clear();
    persistence.set_json(PROVIDER_STATS_KEY, &HashMap::<String, ProviderStat>::new())
}
