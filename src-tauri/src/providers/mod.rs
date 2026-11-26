pub mod alldebrid;
pub mod premiumize;
pub mod real_debrid;
pub mod torbox;
pub mod types;

use async_trait::async_trait;
use std::any::Any;
use types::*;

/// Page size [`DebridProvider::list_all_torrents`] asks for (TorBox's and Real-Debrid's caps are at
/// least this).
pub const LIST_PAGE: u32 = 1000;
/// Stops [`DebridProvider::list_all_torrents`] after this many pages (100k torrents).
const LIST_MAX_PAGES: u32 = 100;

#[async_trait]
pub trait DebridProvider: Send + Sync {
    /// For downcasting to concrete provider types (e.g., RdClient for OAuth flows)
    fn as_any(&self) -> &dyn Any;

    fn info(&self) -> ProviderInfo;

    // Auth: set and validate credentials (not the full OAuth flow)
    async fn authenticate(&self, auth: &ProviderAuth) -> Result<User, ProviderError>;
    async fn is_authenticated(&self) -> bool;

    // Torrents
    async fn list_torrents(&self, page: u32, limit: u32) -> Result<Vec<Torrent>, ProviderError>;

    /// Every torrent on the account. Pages through [`list_torrents`](Self::list_torrents)
    /// [`LIST_PAGE`] at a time until a short page (or a page that brings nothing new, in case a
    /// provider ignores the page number), keeping the first copy of each id.
    async fn list_all_torrents(&self) -> Result<Vec<Torrent>, ProviderError> {
        let mut all = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for page in 1..=LIST_MAX_PAGES {
            let batch = self.list_torrents(page, LIST_PAGE).await?;
            let full = batch.len() >= LIST_PAGE as usize;
            let before = all.len();
            all.extend(batch.into_iter().filter(|t| seen.insert(t.id.clone())));
            if !full || all.len() == before {
                break;
            }
        }
        Ok(all)
    }

    async fn torrent_info(&self, id: &str) -> Result<TorrentInfo, ProviderError>;
    async fn add_magnet(&self, magnet: &str) -> Result<AddTorrentResponse, ProviderError>;
    async fn add_torrent_file(&self, bytes: &[u8]) -> Result<AddTorrentResponse, ProviderError>;
    async fn select_files(&self, id: &str, file_ids: &[u64]) -> Result<(), ProviderError>;
    async fn delete_torrent(&self, id: &str) -> Result<(), ProviderError>;

    // Links & Downloads
    async fn get_download_links(&self, id: &str) -> Result<Vec<DownloadLink>, ProviderError>;
    async fn get_download_link_for_file(
        &self,
        torrent_id: &str,
        file_id: u64,
    ) -> Result<DownloadLink, ProviderError>;

    /// Links for only these files (ids from `TorrentInfo.files`). Like `get_download_links`, a file
    /// that fails is logged and skipped; it errors only when none of the files resolve.
    async fn get_download_links_for_files(
        &self,
        torrent_id: &str,
        file_ids: &[u64],
    ) -> Result<Vec<DownloadLink>, ProviderError> {
        let mut links = Vec::new();
        let mut first_err = None;
        for &file_id in file_ids {
            match self.get_download_link_for_file(torrent_id, file_id).await {
                Ok(link) => links.push(link),
                Err(e) => {
                    log::warn!("Failed to get link for file {}: {}", file_id, e);
                    first_err.get_or_insert(e);
                }
            }
        }
        match first_err {
            Some(e) if links.is_empty() => Err(e),
            _ => Ok(links),
        }
    }

    /// Get a fresh direct URL for a file whose link expired.
    async fn refresh_link(&self, source: &LinkSource) -> Result<DownloadLink, ProviderError>;

    // History
    async fn download_history(
        &self,
        page: u32,
        limit: u32,
    ) -> Result<Vec<DownloadItem>, ProviderError>;

    // Cache availability — returns lowercase hashes that are instantly available
    async fn check_availability(&self, hashes: &[String]) -> Result<Vec<String>, ProviderError>;
}

/// List of all available provider IDs
pub fn available_providers() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo {
            id: "real-debrid".to_string(),
            name: "Real-Debrid".to_string(),
            auth_method: AuthMethod::OAuthDevice,
            supports_streaming: true,
        },
        ProviderInfo {
            id: "torbox".to_string(),
            name: "TorBox".to_string(),
            auth_method: AuthMethod::ApiKey,
            supports_streaming: true,
        },
        ProviderInfo {
            id: "premiumize".to_string(),
            name: "Premiumize".to_string(),
            auth_method: AuthMethod::ApiKey,
            supports_streaming: true,
        },
        ProviderInfo {
            id: "alldebrid".to_string(),
            name: "AllDebrid".to_string(),
            auth_method: AuthMethod::ApiKey,
            supports_streaming: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serves `total` torrents a page at a time (`ignore_page`: always the first page).
    struct Paged {
        total: usize,
        ignore_page: bool,
        asked: Mutex<Vec<(u32, u32)>>,
    }

    fn torrent(id: usize) -> Torrent {
        Torrent {
            id: id.to_string(),
            filename: format!("t{id}"),
            hash: format!("h{id}"),
            bytes: 1,
            progress: 0.0,
            status: "downloaded".into(),
            added: String::new(),
            links: vec![],
            ended: None,
            speed: None,
            seeders: None,
            provider: String::new(),
            copies: vec![],
        }
    }

    #[async_trait]
    impl DebridProvider for Paged {
        fn as_any(&self) -> &dyn Any {
            self
        }
        fn info(&self) -> ProviderInfo {
            unimplemented!()
        }
        async fn authenticate(&self, _: &ProviderAuth) -> Result<User, ProviderError> {
            unimplemented!()
        }
        async fn is_authenticated(&self) -> bool {
            true
        }
        async fn list_torrents(&self, page: u32, limit: u32) -> Result<Vec<Torrent>, ProviderError> {
            self.asked.lock().unwrap().push((page, limit));
            let page = if self.ignore_page { 1 } else { page };
            let start = (page as usize - 1) * limit as usize;
            Ok((start..self.total.min(start + limit as usize)).map(torrent).collect())
        }
        async fn torrent_info(&self, _: &str) -> Result<TorrentInfo, ProviderError> {
            unimplemented!()
        }
        async fn add_magnet(&self, _: &str) -> Result<AddTorrentResponse, ProviderError> {
            unimplemented!()
        }
        async fn add_torrent_file(&self, _: &[u8]) -> Result<AddTorrentResponse, ProviderError> {
            unimplemented!()
        }
        async fn select_files(&self, _: &str, _: &[u64]) -> Result<(), ProviderError> {
            unimplemented!()
        }
        async fn delete_torrent(&self, _: &str) -> Result<(), ProviderError> {
            unimplemented!()
        }
        async fn get_download_links(&self, _: &str) -> Result<Vec<DownloadLink>, ProviderError> {
            unimplemented!()
        }
        async fn get_download_link_for_file(&self, _: &str, _: u64) -> Result<DownloadLink, ProviderError> {
            unimplemented!()
        }
        async fn refresh_link(&self, _: &LinkSource) -> Result<DownloadLink, ProviderError> {
            unimplemented!()
        }
        async fn download_history(&self, _: u32, _: u32) -> Result<Vec<DownloadItem>, ProviderError> {
            unimplemented!()
        }
        async fn check_availability(&self, _: &[String]) -> Result<Vec<String>, ProviderError> {
            unimplemented!()
        }
    }

    fn paged(total: usize, ignore_page: bool) -> Paged {
        Paged { total, ignore_page, asked: Mutex::new(vec![]) }
    }

    #[tokio::test]
    async fn list_all_reads_every_page() {
        // 1716 torrents (a real TorBox account): two pages, the second short.
        let p = paged(1716, false);
        let all = p.list_all_torrents().await.unwrap();
        assert_eq!(all.len(), 1716);
        assert_eq!(all[1715].id, "1715");
        assert_eq!(*p.asked.lock().unwrap(), [(1, LIST_PAGE), (2, LIST_PAGE)]);

        // An exact multiple needs one more (empty) page to know it's done.
        let p = paged(2000, false);
        assert_eq!(p.list_all_torrents().await.unwrap().len(), 2000);
        assert_eq!(p.asked.lock().unwrap().len(), 3);

        assert!(paged(0, false).list_all_torrents().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_all_stops_when_pages_repeat() {
        // A provider that ignores the page number sends page 1 forever; stop once nothing is new.
        let p = paged(5000, true);
        let all = p.list_all_torrents().await.unwrap();
        assert_eq!(all.len(), LIST_PAGE as usize);
        assert_eq!(p.asked.lock().unwrap().len(), 2);
    }
}
