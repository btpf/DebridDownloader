//! A stop must never wait on the network or the speed limit.
use super::mock_server::*;
use super::support::*;
use super::transfer_tests::{deps, http_job};
use crate::engine::limiter::Limiter;
use crate::engine::transfer::*;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Cancel after `after`, and require `run_transfer` to return Stopped within a second of it.
async fn stops_promptly(
    j: crate::engine::Job,
    d: TransferDeps,
    after: Duration,
) -> Vec<TransferUpdate> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let h = tokio::spawn(run_transfer(j, d, cancel.clone(), tx));
    tokio::time::sleep(after).await;
    let t = Instant::now();
    cancel.cancel();
    let r = tokio::time::timeout(Duration::from_secs(5), h).await.expect("transfer ignored the cancel").unwrap();
    assert_eq!(r, Ok(TransferOutcome::Stopped));
    assert!(t.elapsed() < Duration::from_secs(1), "stop took {:?}", t.elapsed());
    let mut ups = Vec::new();
    while let Ok(u) = rx.try_recv() {
        ups.push(u);
    }
    ups
}

#[tokio::test]
async fn a_cancel_while_the_probe_hangs_stops_at_once() {
    // A server that accepts the connection and never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let held = tokio::spawn(async move {
        let mut conns = Vec::new();
        loop {
            let (c, _) = listener.accept().await.unwrap();
            conns.push(c);
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let mut d = deps(no_refresh());
    d.cfg.idle_timeout = Duration::from_secs(60); // the timeout must not be what ends it
    let j = http_job(&dir, "hang.bin", format!("http://127.0.0.1:{port}/f"), 0);
    let ups = stops_promptly(j, d, Duration::from_millis(200)).await;
    assert!(!ups.iter().any(|u| matches!(u, TransferUpdate::Probed { .. })));
    held.abort();
}

#[tokio::test]
async fn a_cancel_while_throttled_stops_at_once_and_keeps_what_was_written() {
    let s = MockServer::start(MockOpts { size: 1024 * 1024, ranges: true, ..Default::default() }).await;
    let dir = tempfile::tempdir().unwrap();
    let mut d = deps(no_refresh());
    // 1 KiB/s: the first chunk alone puts every segment many seconds into debt.
    d.limiter = Arc::new(Limiter::new(Some(1024)));
    let j = http_job(&dir, "slow.bin", s.url(), 0);
    let part = j.part_path();
    let ups = stops_promptly(j, d, Duration::from_millis(500)).await;

    // The last checkpoint only claims bytes that are really in the `.part`.
    let segments = ups
        .iter()
        .rev()
        .find_map(|u| match u {
            TransferUpdate::Checkpoint { segments } => Some(segments.clone()),
            _ => None,
        })
        .expect("a checkpoint on stop");
    assert!(segments.iter().any(|s| s.done > 0), "the chunk in hand was kept");
    let on_disk = read(&part);
    let data = s.data();
    for seg in &segments {
        let (a, b) = (seg.start as usize, (seg.start + seg.done) as usize);
        assert_eq!(on_disk[a..b], data[a..b], "segment at {a} claims bytes it didn't write");
    }
}

#[cfg(windows)]
mod sparse {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;

    fn is_sparse(path: &std::path::Path) -> bool {
        std::fs::metadata(path).unwrap().file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE != 0
    }

    #[test]
    fn a_sparse_part_can_be_written_near_its_end_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.part");
        let mut f = std::fs::File::create(&p).unwrap();
        crate::engine::sparse::mark_sparse(&f).unwrap();
        let size: u64 = 20 * 1024 * 1024 * 1024;
        f.set_len(size).unwrap();
        let t = Instant::now();
        f.seek(SeekFrom::Start(size - 4096)).unwrap();
        f.write_all(&[7u8; 4096]).unwrap();
        f.sync_all().unwrap();
        // Without the sparse flag this write would zero-fill 20 GB first.
        assert!(t.elapsed() < Duration::from_secs(5), "write took {:?}", t.elapsed());
        drop(f);
        assert!(is_sparse(&p));
        assert_eq!(std::fs::metadata(&p).unwrap().len(), size);
    }

    /// Download a small file and report whether it ended up sparse.
    async fn downloads_sparse(sparse_files: bool) -> bool {
        let s = MockServer::start(MockOpts { size: 512 * 1024, ranges: true, ..Default::default() }).await;
        let dir = tempfile::tempdir().unwrap();
        let mut d = deps(no_refresh());
        d.cfg.sparse_files = sparse_files;
        let j = http_job(&dir, "f.bin", s.url(), 0);
        let (tx, _rx) = mpsc::unbounded_channel();
        assert_eq!(run_transfer(j.clone(), d, CancellationToken::new(), tx).await, Ok(TransferOutcome::Finished));
        assert_eq!(read(&j.destination), s.data());
        is_sparse(std::path::Path::new(&j.destination))
    }

    #[tokio::test]
    async fn the_setting_decides_whether_the_part_file_is_sparse() {
        assert!(downloads_sparse(true).await);
        assert!(!downloads_sparse(false).await);
    }
}
