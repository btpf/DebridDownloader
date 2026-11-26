//! "Connections per file" changed while a download runs.
use super::mock_server::*;
use super::support::*;
use super::transfer_tests::{deps, http_job};
use crate::engine::transfer::*;
use crate::engine::types::*;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// A transfer running in the background, with its updates collected as they arrive.
struct Running {
    rx: mpsc::UnboundedReceiver<TransferUpdate>,
    ups: Vec<TransferUpdate>,
    cancel: CancellationToken,
    handle: JoinHandle<Result<TransferOutcome, TransferError>>,
    setting: watch::Sender<u32>,
}

impl Running {
    fn start(job: Job, connections: u32) -> Self {
        let (setting, srx) = watch::channel(connections);
        let mut d = deps(no_refresh());
        d.segments = Some(srx);
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_transfer(job, d, cancel.clone(), tx));
        Self { rx, ups: Vec::new(), cancel, handle, setting }
    }

    /// Wait (up to 10 s) for an update matching `pred`; returns how many updates came before it.
    async fn wait_for(&mut self, what: &str, pred: impl Fn(&TransferUpdate) -> bool) -> usize {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let u = tokio::time::timeout_at(deadline, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
                .unwrap_or_else(|| panic!("transfer ended before {what}"));
            let hit = pred(&u);
            self.ups.push(u);
            if hit {
                return self.ups.len() - 1;
            }
        }
    }

    async fn finish(mut self) -> (Result<TransferOutcome, TransferError>, Vec<TransferUpdate>) {
        let r = tokio::time::timeout(Duration::from_secs(30), self.handle).await.expect("transfer hung").unwrap();
        while let Ok(u) = self.rx.try_recv() {
            self.ups.push(u);
        }
        (r, self.ups)
    }
}

fn active(u: &TransferUpdate) -> Option<u32> {
    match u {
        TransferUpdate::Progress { segments_active, .. } => Some(*segments_active),
        _ => None,
    }
}

fn last_segments(ups: &[TransferUpdate]) -> Vec<SegmentState> {
    ups.iter()
        .rev()
        .find_map(|u| match u {
            TransferUpdate::Checkpoint { segments } => Some(segments.clone()),
            _ => None,
        })
        .expect("a checkpoint")
}

/// Segments tile `0..size` exactly: no gap, no overlap.
fn assert_tiles(segments: &[SegmentState], size: u64) {
    let mut s: Vec<_> = segments.to_vec();
    s.sort_by_key(|s| s.start);
    let mut next = 0;
    for seg in &s {
        assert_eq!(seg.start, next, "gap or overlap in {s:?}");
        next = seg.end + 1;
    }
    assert_eq!(next, size, "segments don't cover the file: {s:?}");
}

fn slow_server_opts(size: usize) -> MockOpts {
    MockOpts { size, ranges: true, chunk_delay: Some(Duration::from_millis(5)), ..Default::default() }
}

#[tokio::test]
async fn raising_connections_mid_download_splits_at_once() {
    let size = 2 * 1024 * 1024;
    let s = MockServer::start(slow_server_opts(size)).await;
    let dir = tempfile::tempdir().unwrap();
    let j = http_job(&dir, "up.bin", s.url(), size as i64);
    let mut t = Running::start(j.clone(), 1);

    t.wait_for("bytes on one connection", |u| matches!(u, TransferUpdate::Progress { downloaded, .. } if *downloaded > 0)).await;
    assert!(t.ups.iter().filter_map(active).all(|n| n <= 1), "cap 1 ran more than one connection");
    t.setting.send(4).unwrap();
    t.wait_for("more than one active connection", |u| active(u).is_some_and(|n| n > 1)).await;

    let (r, ups) = t.finish().await;
    assert_eq!(r, Ok(TransferOutcome::Finished));
    assert!(s.max_active() > 1, "the server never saw a second connection");
    assert!(ups.iter().filter_map(active).all(|n| n <= 4));
    assert_tiles(&last_segments(&ups), size as u64);
    assert_eq!(read(&j.destination), s.data());
}

#[tokio::test]
async fn lowering_connections_mid_download_stops_the_surplus() {
    let size = 3 * 1024 * 1024;
    let s = MockServer::start(slow_server_opts(size)).await;
    let dir = tempfile::tempdir().unwrap();
    let j = http_job(&dir, "down.bin", s.url(), size as i64);
    let mut t = Running::start(j.clone(), 4);

    // Lower once each connection has real progress, so re-fetching it would show up below.
    t.wait_for("four connections a third of the way in", |u| {
        matches!(u, TransferUpdate::Progress { downloaded, segments_active: 4, .. } if *downloaded >= size as u64 / 3)
    })
    .await;
    t.setting.send(1).unwrap();
    let at = t.wait_for("one active connection", |u| active(u) == Some(1)).await;
    // Give the stopped workers time to return and re-queue, then check it stays at one.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let (r, ups) = t.finish().await;
    assert_eq!(r, Ok(TransferOutcome::Finished));
    let after: Vec<u32> = ups[at..].iter().filter_map(active).collect();
    assert!(after.iter().all(|&n| n <= 1), "more than one connection after lowering: {after:?}");
    assert_tiles(&last_segments(&ups), size as u64);
    assert_eq!(read(&j.destination), s.data());
    // Stopped segments resume where they left off: nothing is fetched twice beyond what was in
    // flight when the three surplus connections were stopped.
    let slack = 3 * 64 * 1024 + 1;
    assert!(s.served() <= size as u64 + slack, "served {} bytes for a {} byte file", s.served(), size);
}

#[tokio::test]
async fn raising_connections_never_exceeds_a_server_imposed_limit() {
    let size = 2 * 1024 * 1024;
    let s = MockServer::start(MockOpts { conn_limit: Some(2), ..slow_server_opts(size) }).await;
    let dir = tempfile::tempdir().unwrap();
    let mut j = http_job(&dir, "limit.bin", s.url(), size as i64);
    j.max_segments = 2; // learned earlier from this host refusing connections
    let mut t = Running::start(j.clone(), 1);

    t.wait_for("bytes on one connection", |u| matches!(u, TransferUpdate::Progress { downloaded, .. } if *downloaded > 0)).await;
    t.setting.send(8).unwrap();
    t.wait_for("two active connections", |u| active(u) == Some(2)).await;

    let (r, ups) = t.finish().await;
    assert_eq!(r, Ok(TransferOutcome::Finished));
    assert!(ups.iter().filter_map(active).all(|n| n <= 2), "went past the server's limit");
    assert!(s.max_active() <= 2);
    assert!(!ups.iter().any(|u| matches!(u, TransferUpdate::MaxSegments(_))), "the server never had to refuse");
    assert_eq!(read(&j.destination), s.data());
}

#[tokio::test]
async fn pausing_after_a_live_change_checkpoints_and_resumes() {
    let size = 3 * 1024 * 1024;
    let s = MockServer::start(slow_server_opts(size)).await;
    let dir = tempfile::tempdir().unwrap();
    let mut j = http_job(&dir, "pause.bin", s.url(), size as i64);
    let mut t = Running::start(j.clone(), 1);

    t.wait_for("bytes on one connection", |u| matches!(u, TransferUpdate::Progress { downloaded, .. } if *downloaded > 0)).await;
    t.setting.send(4).unwrap();
    t.wait_for("four active connections", |u| active(u) == Some(4)).await;
    t.setting.send(2).unwrap();
    t.wait_for("two active connections", |u| active(u) == Some(2)).await;
    t.cancel.cancel();
    let (r, ups) = t.finish().await;
    assert_eq!(r, Ok(TransferOutcome::Stopped));

    // The pause checkpoint only claims bytes that are really in the `.part`, and still tiles the file.
    let segments = last_segments(&ups);
    assert!(segments.len() >= 4, "the raise split the file: {segments:?}");
    assert_tiles(&segments, size as u64);
    let on_disk = read(j.part_path());
    let data = s.data();
    for seg in &segments {
        let (a, b) = (seg.start as usize, (seg.start + seg.done) as usize);
        assert_eq!(on_disk[a..b], data[a..b], "segment at {a} claims bytes it didn't write");
    }
    assert!(segments.iter().any(|s| !s.is_done()), "paused before the end");

    // Resume as the actor would: persisted segments, same `.part`.
    j.segments = segments;
    j.resumable = true;
    let (r, _) = Running::start(j.clone(), 2).finish().await;
    assert_eq!(r, Ok(TransferOutcome::Finished));
    assert_eq!(read(&j.destination), s.data());
}
