import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMiniPlayer } from "../contexts/MiniPlayerContext";
import { open } from "@tauri-apps/plugin-dialog";
import DataTable, { type Column } from "../components/DataTable";
import AddTorrentModal from "../components/AddTorrentModal";
import ZipContentsDialog from "../components/ZipContentsDialog";
import * as torrentsApi from "../api/torrents";
import * as downloadsApi from "../api/downloads";
import { getSettings } from "../api/settings";
import { getStreamUrl } from "../api/streaming";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirmAction } from "../lib/confirm";
import type { Torrent, TorrentInfo, AppSettings } from "../types";
import { providerName, torrentCopies, torrentKey } from "../lib/providers";
import { getCachedTorrents, setCachedTorrents, updateCachedTorrents } from "../lib/torrentsCache";
import { useAuth } from "../hooks/useAuth";
import { Button, cn, ContextMenu, Dialog, IconButton, Inspector, Menu, Spinner, StatusDot, Toolbar, type MenuItem } from "../components/ui";
import {
  formatBytes,
  formatRelativeTime,
  torrentStatusDot,
  torrentStatusLabel,
} from "../utils";

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const MoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
);

const RefreshIcon = ({ spinning }: { spinning: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={spinning ? "animate-spin" : undefined}
  >
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const VerticalMoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
  </svg>
);

/** No provider has the torrent ready (no green dot), so starting it over may help. */
const noCopyReady = (t: Torrent) => !torrentCopies(t).some((c) => c.status === "downloaded");

/** Copy via a hidden textarea (the right-click menu's original copy path). */
function copyText(text: string) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}

const INLINE_VIDEO_EXTS = [".mp4", ".webm", ".mov", ".m4v", ".mkv"];
const EXTERNAL_VIDEO_EXTS = [".avi", ".wmv", ".flv", ".ts"];

const getFileExt = (path: string) => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
};

const isInlineVideo = (path: string) => INLINE_VIDEO_EXTS.includes(getFileExt(path));
const isExternalVideo = (path: string) => EXTERNAL_VIDEO_EXTS.includes(getFileExt(path));
const isArchive = (path: string) => [".zip", ".rar"].includes(getFileExt(path));
const baseName = (path: string) => path.split("/").pop() || path;
/** `undefined` for an empty provider id, so the backend falls back to the primary provider. */
const providerArg = (p: string | undefined) => p || undefined;

/** Each provider holding the torrent: a dot in that copy's status color, then the provider's name. */
function ProviderList({ torrent }: { torrent: Torrent }) {
  const copies = torrentCopies(torrent);
  const title = copies.map((c) => `${providerName(c.provider)}: ${torrentStatusLabel(c.status)}`).join("\n");
  return (
    <span className="flex min-w-0 items-center gap-2.5 overflow-hidden" title={title}>
      {copies.map((c) => (
        <StatusDot key={`${c.provider}:${c.id}`} status={torrentStatusDot(c.status)}>
          <span className="truncate">{c.provider ? providerName(c.provider) : torrentStatusLabel(c.status)}</span>
        </StatusDot>
      ))}
    </span>
  );
}

export default function TorrentsPage() {
  // Opening the tab again shows the cached list at once (see lib/torrentsCache).
  const [torrents, setTorrents] = useState<Torrent[]>(() => getCachedTorrents()?.torrents ?? []);
  const [loading, setLoading] = useState(() => getCachedTorrents() === null);
  const [refreshing, setRefreshing] = useState(false);
  const { accounts } = useAuth();
  // The providers the list comes from; enabling, disabling, signing in or out changes it.
  const activeProviders = accounts.filter((a) => a.enabled && a.authenticated).map((a) => a.id).join(",");
  const activeProvidersRef = useRef(activeProviders);
  activeProvidersRef.current = activeProviders;
  const [error, setError] = useState("");
  /** `torrentKey` of the selected row. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<string | null>("added");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const filterRef = useRef<HTMLInputElement>(null);

  // Slide-over detail state
  const [detailInfo, setDetailInfo] = useState<TorrentInfo | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [zipTarget, setZipTarget] = useState<{ torrentId: string; fileId: number | null; name: string; torrentName: string } | null>(null);
  const [notice, setNotice] = useState("");
  const selected = useMemo(() => torrents.find((t) => torrentKey(t) === selectedId) ?? null, [torrents, selectedId]);
  // The copy the inspector shows and acts on (see `merge_torrents`).
  const selectedTorrentId = selected?.id ?? null;
  const selectedProvider = selected?.provider ?? "";
  // "Download Contents" is only enabled for Real-Debrid, the one provider it's been tested with.
  const archiveContents = detailInfo?.provider === "real-debrid";

  const { openPreview, loadingTorrentId: miniPlayerLoadingId } = useMiniPlayer();

  // Inline playback goes to the floating mini player (resizable, fullscreen) rather than the narrow inspector.
  const [streamError, setStreamError] = useState<string | null>(null);

  const handlePlayExternal = async (fileId: number) => {
    if (!detailInfo) return;
    try {
      const result = await getStreamUrl(detailInfo.id, fileId, providerArg(detailInfo.provider));
      await openUrl(result.stream_url);
      // Don't immediately clean up — external player needs the session alive for streaming
    } catch (e) {
      setStreamError(e instanceof Error ? e.message : String(e));
    }
  };

  // Refreshes (after an add, a delete, a drop...) keep the current rows on screen until the new
  // list arrives; only the first load shows the spinner. Swapping the table for a spinner on every
  // refresh made the list flicker.
  const fetchTorrents = useCallback(async () => {
    setRefreshing(true);
    try {
      const providers = activeProvidersRef.current;
      const data = await torrentsApi.listTorrents();
      // Cached even if the tab was left meanwhile, so the next visit gets it.
      setCachedTorrents(data, providers);
      setTorrents(data);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Fetch on the first visit and when the active providers change; otherwise the cached list
  // stands until the Refresh button (or an add, delete or retry) fetches it again.
  useEffect(() => {
    const cached = getCachedTorrents();
    if (!cached || cached.providers !== activeProviders) fetchTorrents();
  }, [activeProviders, fetchTorrents]);
  useEffect(() => { updateCachedTorrents(torrents); }, [torrents]);
  useEffect(() => { getSettings().then(setSettings).catch(() => {}); }, []);

  // Fetch detail when the selected copy changes
  useEffect(() => {
    if (!selectedTorrentId) { setDetailInfo(null); return; }
    const fetchInfo = async () => {
      setDetailLoading(true);
      setDetailError("");
      try {
        const data = await torrentsApi.getTorrentInfo(selectedTorrentId, providerArg(selectedProvider));
        setDetailInfo(data);
        setSelectedFiles(new Set(data.files.filter((f) => f.selected).map((f) => f.id)));
      } catch (e) {
        setDetailError(String(e));
      } finally {
        setDetailLoading(false);
      }
    };
    fetchInfo();
  }, [selectedTorrentId, selectedProvider]);

  // Window event listeners
  useEffect(() => {
    const handler = () => fetchTorrents();
    window.addEventListener("refresh-list", handler);
    return () => window.removeEventListener("refresh-list", handler);
  }, [fetchTorrents]);

  useEffect(() => {
    const handler = (e: Event) => setSelectedId((e as CustomEvent).detail);
    window.addEventListener("torrent-select", handler);
    return () => window.removeEventListener("torrent-select", handler);
  }, []);

  useEffect(() => {
    const handler = () => { setStreamError(null); setSelectedId(null); };
    window.addEventListener("deselect-item", handler);
    return () => window.removeEventListener("deselect-item", handler);
  }, []);

  useEffect(() => {
    const onAdd = () => setShowAdd(true);
    const onFocus = () => filterRef.current?.focus();
    const onToggle = () => setInspectorOpen((o) => !o);
    window.addEventListener("open-add-torrent", onAdd);
    window.addEventListener("focus-filter", onFocus);
    window.addEventListener("toggle-inspector", onToggle);
    return () => {
      window.removeEventListener("open-add-torrent", onAdd);
      window.removeEventListener("focus-filter", onFocus);
      window.removeEventListener("toggle-inspector", onToggle);
    };
  }, []);

  useEffect(() => {
    const handler = () => { if (selected) confirmDelete(selected); };
    window.addEventListener("delete-selected", handler);
    return () => window.removeEventListener("delete-selected", handler);
  }, [selected]);

  useEffect(() => {
    const handler = () => { if (selected) handleDownloadTorrent(selected); };
    window.addEventListener("action-selected", handler);
    return () => window.removeEventListener("action-selected", handler);
  }, [selected, settings]);

  /** Delete every provider's copy of the torrent. */
  const deleteCopies = async (t: Torrent) => {
    for (const c of torrentCopies(t)) await torrentsApi.deleteTorrent(c.id, providerArg(c.provider));
  };

  const handleDelete = async (t: Torrent) => {
    const key = torrentKey(t);
    try {
      await deleteCopies(t);
      setTorrents((prev) => prev.filter((x) => torrentKey(x) !== key));
      if (selectedId === key) setSelectedId(null);
    } catch (e) { setError(String(e)); fetchTorrents(); }
  };

  /** "Delete this torrent?", naming the providers when it's on more than one. */
  const deletePrompt = (t: Torrent) => {
    const copies = torrentCopies(t);
    return copies.length > 1
      ? `Delete this torrent from ${copies.map((c) => providerName(c.provider)).join(", ")}?`
      : "Delete this torrent?";
  };

  /** Delete only after the user answers Yes; the dialog is async in Tauri (#47). */
  const confirmDelete = async (t: Torrent) => {
    if (await confirmAction(deletePrompt(t))) await handleDelete(t);
  };

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  /** Runs after the "Are you sure?" dialog's Delete All. */
  const handleDeleteAll = async () => {
    setDeletingAll(true);
    try {
      for (const t of torrents) {
        await deleteCopies(t).catch(() => {});
      }
      setTorrents([]);
      setSelectedId(null);
    } catch (e) { setError(String(e)); }
    finally {
      setDeletingAll(false);
      setConfirmDeleteAll(false);
    }
  };

  /** Delete each copy and add the torrent's magnet back to the same provider. */
  const handleRetry = async (t: Torrent) => {
    setError("");
    try {
      await torrentsApi.retryTorrent(t.hash, torrentCopies(t).map((c) => ({ provider: c.provider, id: c.id })));
      if (selectedId === torrentKey(t)) setSelectedId(null);
      setNotice(`Retrying ${t.filename}`);
    } catch (e) {
      setError(`Couldn't retry ${t.filename}: ${String(e)}`);
    } finally {
      fetchTorrents();
    }
  };

  const handleDownloadTorrent = async (torrent: Torrent) => {
    try {
      // Symlink mode: backend uses library path from settings, no folder picker needed
      let folder = settings?.download_folder ?? null;
      if (settings?.symlink_mode) {
        if (!settings?.symlink_mount_path || !settings?.symlink_library_path) {
          setError("Symlink mode is on but mount path or library folder is not configured. Check Settings.");
          return;
        }
        folder = settings.symlink_library_path;
      } else if (!folder) {
        const picked = await open({ directory: true, title: "Select download folder" });
        if (!picked) return;
        folder = picked as string;
      }
      const links = await downloadsApi.unrestrictTorrentLinks(torrent.id, undefined, providerArg(torrent.provider));
      if (links.length > 0) await downloadsApi.startDownloads(links, folder, torrent.filename);
    } catch (e) { setError(String(e)); }
  };

  const handleSelectFiles = async () => {
    if (!detailInfo) return;
    setSaving(true);
    try {
      const ids = Array.from(selectedFiles).join(",");
      await torrentsApi.selectTorrentFiles(detailInfo.id, ids || "all", providerArg(detailInfo.provider));
      fetchTorrents();
    } catch (e) { setDetailError(String(e)); }
    finally { setSaving(false); }
  };

  // Files the user can tick: any file while Real-Debrid waits for a selection, otherwise only the
  // files the provider has links for (RD drops the ones left out at selection time).
  const waitingSelection = detailInfo?.status === "waiting_files_selection";
  const canDownload = detailInfo?.status === "downloaded";
  const pickable = !detailInfo ? [] : waitingSelection ? detailInfo.files : canDownload ? detailInfo.files.filter((f) => f.selected) : [];
  const picked = pickable.filter((f) => selectedFiles.has(f.id));
  const allPicked = picked.length === pickable.length;
  const showPicker = waitingSelection || pickable.length > 1;

  const toggleFile = (id: number) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllFiles = () => setSelectedFiles(allPicked ? new Set() : new Set(pickable.map((f) => f.id)));

  const handleDetailDownload = async () => {
    if (!detailInfo) return;
    setDownloading(true);
    try {
      const s = await getSettings();
      let folder = s.download_folder;
      if (s.symlink_mode) {
        if (!s.symlink_mount_path || !s.symlink_library_path) {
          setDetailError("Symlink mode is on but mount path or library folder is not configured. Check Settings.");
          setDownloading(false);
          return;
        }
        folder = s.symlink_library_path;
      } else if (!folder) {
        const chosen = await open({ directory: true, title: "Select download folder" });
        if (!chosen) { setDownloading(false); return; }
        folder = chosen as string;
      }
      // All ticked fetches every link in one go, which also works when RD packed the files into one archive.
      const fileIds = allPicked ? undefined : picked.map((f) => f.id);
      const links = await downloadsApi.unrestrictTorrentLinks(detailInfo.id, fileIds, providerArg(detailInfo.provider));
      if (links.length === 0) {
        setDetailError("No download links are available for this torrent yet.");
        return;
      }
      await downloadsApi.startDownloads(links, folder, detailInfo.filename);
      fetchTorrents();
    } catch (e) { setDetailError(String(e)); }
    finally { setDownloading(false); }
  };

  const handleDetailDelete = async () => {
    if (!detailInfo || !selected || !(await confirmAction(deletePrompt(selected)))) return;
    try {
      await deleteCopies(selected);
      setSelectedId(null);
      fetchTorrents();
    } catch (e) { setDetailError(String(e)); }
  };

  // Sort + filter
  const filtered = useMemo(() => {
    let result = torrents;
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter((t) => t.filename.toLowerCase().includes(q));
    }
    if (sortKey) {
      result = [...result].sort((a, b) => {
        let cmp = 0;
        if (sortKey === "filename") cmp = a.filename.localeCompare(b.filename);
        else if (sortKey === "bytes") cmp = a.bytes - b.bytes;
        else if (sortKey === "added") cmp = new Date(a.added).getTime() - new Date(b.added).getTime();
        return sortDirection === "asc" ? cmp : -cmp;
      });
    }
    return result;
  }, [torrents, filter, sortKey, sortDirection]);

  const totalBytes = torrents.reduce((s, t) => s + t.bytes, 0);

  const selectRow = (id: string) => { setSelectedId(id); setInspectorOpen(true); };
  const closeInspector = () => { setStreamError(null); setSelectedId(null); };

  // Right-click menu: same actions and handlers as the old positioned menu.
  const preview = (t: Torrent) => openPreview(t.id, undefined, undefined, providerArg(t.provider));
  const rowMenuItems = (t: Torrent): MenuItem[] => [
    { label: "Preview", onSelect: () => preview(t) },
    { label: "Download", onSelect: () => handleDownloadTorrent(t) },
    ...(noCopyReady(t) && t.hash ? [{ label: "Retry", onSelect: () => { void handleRetry(t); } }] : []),
    { label: "Delete", danger: true, onSelect: () => { confirmDelete(t); } },
    { label: "Copy Magnet", onSelect: () => copyText("magnet:?xt=urn:btih:" + t.hash) },
  ];

  const columns: Column<Torrent>[] = [
    {
      key: "filename",
      header: "Name",
      width: "minmax(0, 1fr)",
      sortable: true,
      render: (t) => <div className="truncate text-base text-fg">{t.filename}</div>,
    },
    {
      key: "bytes",
      header: "Size",
      width: 20,
      sortable: true,
      render: (t) => <span className="text-base text-fg-secondary tabular">{formatBytes(t.bytes)}</span>,
    },
    {
      key: "added",
      header: "Added",
      width: 24,
      sortable: true,
      render: (t) => <span className="text-sm text-fg-muted tabular">{formatRelativeTime(t.added)}</span>,
    },
    {
      // Which providers hold the torrent; each dot is that copy's status (full status on hover).
      key: "provider",
      header: "Provider",
      width: 44,
      render: (t) => <ProviderList torrent={t} />,
    },
    {
      key: "actions",
      header: "",
      width: 22,
      render: (t) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {miniPlayerLoadingId === t.id && <Spinner size="sm" />}
          {t.status === "downloaded" && (
            <IconButton label="Download" onClick={() => handleDownloadTorrent(t)}>
              <DownloadIcon />
            </IconButton>
          )}
          <Menu
            trigger={
              <IconButton label="More actions">
                <MoreIcon />
              </IconButton>
            }
            items={[
              { label: "Preview Video", onSelect: () => preview(t), disabled: miniPlayerLoadingId === t.id },
              { label: "Copy Magnet", onSelect: () => { navigator.clipboard.writeText("magnet:?xt=urn:btih:" + t.hash).catch(() => {}); } },
              "separator",
              { label: "Delete", danger: true, onSelect: () => { confirmDelete(t); } },
            ]}
          />
        </div>
      ),
    },
  ];

  const inspectorVisible = !!selectedId && inspectorOpen;
  const zipFiles = canDownload && archiveContents ? detailInfo.files.filter((f) => f.selected && isArchive(f.path)) : [];
  // Real-Debrid serves a torrent with many files as one RAR it packs itself: one link, many files.
  const packed = canDownload && archiveContents && detailInfo.links.length === 1 && detailInfo.files.filter((f) => f.selected).length > 1;
  const openPacked = () => {
    if (!detailInfo) return;
    setZipTarget({ torrentId: detailInfo.id, fileId: null, name: detailInfo.filename, torrentName: detailInfo.filename });
  };
  const openZip = (fileId: number, path: string) => {
    if (!detailInfo) return;
    setZipTarget({ torrentId: detailInfo.id, fileId, name: baseName(path), torrentName: detailInfo.filename });
  };

  return (
    <>
      <Toolbar
        title="Torrents"
        subtitle={`${torrents.length} items · ${formatBytes(totalBytes)}`}
        filter={{ value: filter, onChange: setFilter, placeholder: "Filter torrents", inputRef: filterRef }}
        actions={
          <>
            <IconButton label="Refresh" onClick={() => { void fetchTorrents(); }} disabled={refreshing}>
              <RefreshIcon spinning={refreshing} />
            </IconButton>
            <Button variant="primary" kbd="Mod+N" onClick={() => setShowAdd(true)}>
              Add Torrent
            </Button>
            <Menu
              trigger={
                <IconButton label="Torrent list actions">
                  <VerticalMoreIcon />
                </IconButton>
              }
              items={[
                {
                  label: torrents.length > 0 ? `Delete All (${torrents.length})…` : "Delete All…",
                  danger: true,
                  disabled: torrents.length === 0,
                  onSelect: () => setConfirmDeleteAll(true),
                },
              ]}
            />
          </>
        }
      />

      {error && <div className="border-b border-border px-4 py-2 text-sm text-danger">{error}</div>}
      {notice && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm text-fg-secondary">
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <Button size="sm" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <DataTable
            columns={columns}
            data={filtered}
            rowKey={torrentKey}
            onRowClick={(t) => selectRow(torrentKey(t))}
            onKeyboardSelect={(t) => selectRow(torrentKey(t))}
            rowWrapper={(t, row) => <ContextMenu items={rowMenuItems(t)}>{row}</ContextMenu>}
            selectedId={selectedId}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onSort={(key, dir) => { setSortKey(key); setSortDirection(dir); }}
            emptyMessage="No torrents yet"
            emptySubtext="Add a magnet link or torrent file to get started"
            loading={loading}
          />
        </div>

        <Inspector
          id="torrents"
          open={inspectorVisible}
          onClose={closeInspector}
          title={detailInfo?.filename ?? selected?.filename ?? "Torrent"}
          subtitle={detailInfo ? `${formatBytes(detailInfo.bytes)} · ${torrentStatusLabel(detailInfo.status)}` : undefined}
          footer={
            detailInfo ? (
              <>
                {detailInfo.status === "waiting_files_selection" && (
                  <Button variant="primary" onClick={handleSelectFiles} disabled={saving || selectedFiles.size === 0}>
                    {saving ? "Saving..." : "Select Files & Start"}
                  </Button>
                )}
                {packed && (
                  <Button variant="primary" onClick={openPacked}>
                    Download Contents
                  </Button>
                )}
                {canDownload && (
                  <Button variant={packed ? "secondary" : "primary"} onClick={handleDetailDownload} disabled={downloading || (pickable.length > 0 && picked.length === 0)}>
                    {downloading
                      ? "Starting..."
                      : packed
                        ? "Download Archive"
                        : allPicked || picked.length === 0
                          ? "Download"
                          : `Download ${picked.length} ${picked.length === 1 ? "file" : "files"}`}
                  </Button>
                )}
                {!packed && zipFiles.length === 1 && (
                  <Button onClick={() => openZip(zipFiles[0].id, zipFiles[0].path)}>
                    Download Contents
                  </Button>
                )}
                {canDownload && (
                  <Button onClick={() => openPreview(detailInfo.id, undefined, undefined, providerArg(detailInfo.provider))} disabled={miniPlayerLoadingId === detailInfo.id}>
                    Preview
                  </Button>
                )}
                <Button variant="danger" onClick={handleDetailDelete}>
                  Delete
                </Button>
              </>
            ) : undefined
          }
        >
          {detailLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : detailInfo ? (
            <div className="flex flex-col gap-4">
              {detailError && <p className="text-sm text-danger">{detailError}</p>}

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-fg-muted">Status</dt>
                <dd><StatusDot status={torrentStatusDot(detailInfo.status)}><span className="text-sm">{torrentStatusLabel(detailInfo.status)}</span></StatusDot></dd>
                {selected && (
                  <>
                    <dt className="text-fg-muted">{torrentCopies(selected).length > 1 ? "Providers" : "Provider"}</dt>
                    <dd className="flex flex-col gap-0.5">
                      {torrentCopies(selected).map((c) => (
                        <StatusDot key={`${c.provider}:${c.id}`} status={torrentStatusDot(c.status)}>
                          <span className="text-sm">
                            {providerName(c.provider)}
                            <span className="text-fg-muted"> · {torrentStatusLabel(c.status)}</span>
                          </span>
                        </StatusDot>
                      ))}
                    </dd>
                  </>
                )}
                <dt className="text-fg-muted">Size</dt>
                <dd className="text-fg tabular">{formatBytes(detailInfo.bytes)}</dd>
                <dt className="text-fg-muted">Added</dt>
                <dd className="text-fg tabular">{new Date(detailInfo.added).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
                <dt className="text-fg-muted">Links</dt>
                <dd className="text-fg tabular">{detailInfo.links.length}</dd>
                <dt className="text-fg-muted">Hash</dt>
                <dd className="truncate font-mono text-fg-secondary" title={detailInfo.hash}>{detailInfo.hash}</dd>
              </dl>

              {streamError && <p className="text-sm text-danger" role="alert">{streamError}</p>}

              {/* Files */}
              {detailInfo.files.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                      Files ({detailInfo.files.length})
                    </div>
                    {showPicker && (
                      <Button variant="ghost" size="sm" className="-my-1" onClick={toggleAllFiles}>
                        {allPicked ? "Select none" : "Select all"}
                      </Button>
                    )}
                  </div>
                  {/* No inner scroll: names wrap in full, so the inspector body scrolls instead. */}
                  <div className="rounded-md border border-border">
                    {detailInfo.files.map((file) => {
                      const path = file.path.startsWith("/") ? file.path.slice(1) : file.path;
                      const slash = path.lastIndexOf("/");
                      const name = path.slice(slash + 1);
                      const folder = slash >= 0 ? path.slice(0, slash) : "";
                      const unavailable = canDownload && !file.selected;
                      const isPickable = showPicker && !unavailable;
                      const checkboxId = `torrent-file-${file.id}`;
                      return (
                        <div
                          key={file.id}
                          className="flex items-start gap-2 border-b border-border-subtle px-2 py-1.5 last:border-b-0 hover:bg-raised"
                        >
                          {showPicker && (
                            <input
                              id={checkboxId}
                              type="checkbox"
                              aria-label={`Select ${path}`}
                              checked={isPickable && selectedFiles.has(file.id)}
                              disabled={!isPickable}
                              title={isPickable ? undefined : "Not on the server: this file was left out when the torrent was added"}
                              onChange={() => toggleFile(file.id)}
                              className="size-4 shrink-0 accent-accent disabled:opacity-40"
                            />
                          )}

                          {canDownload && isInlineVideo(file.path) && (
                            <IconButton
                              size="sm"
                              label="Play in preview"
                              className="-my-1"
                              onClick={() => openPreview(detailInfo.id, file.id, name || file.path, providerArg(detailInfo.provider))}
                              disabled={miniPlayerLoadingId === detailInfo.id}
                            >
                              {miniPlayerLoadingId === detailInfo.id ? <Spinner size="sm" /> : <span className="text-xs">▶</span>}
                            </IconButton>
                          )}

                          {canDownload && isExternalVideo(file.path) && (
                            <IconButton size="sm" label="Open in external player" className="-my-1" onClick={() => handlePlayExternal(file.id)}>
                              <span className="text-xs">▶↗</span>
                            </IconButton>
                          )}

                          <label
                            htmlFor={isPickable ? checkboxId : undefined}
                            className={cn("min-w-0 flex-1", isPickable && "cursor-pointer")}
                          >
                            <span className={cn("block break-words text-sm", unavailable ? "text-fg-muted" : "text-fg")}>{name}</span>
                            {folder && <span className="block break-words text-xs text-fg-muted">{folder}</span>}
                          </label>
                          {canDownload && archiveContents && file.selected && isArchive(file.path) && (
                            <Button size="sm" className="-my-1" onClick={() => openZip(file.id, file.path)}>
                              Contents
                            </Button>
                          )}
                          <span className="shrink-0 text-sm text-fg-muted tabular">{formatBytes(file.bytes)}</span>
                        </div>
                      );
                    })}
                  </div>
                  {showPicker && (
                    <p className="mt-1.5 text-sm text-fg-muted tabular">
                      {picked.length} of {pickable.length} selected, {formatBytes(picked.reduce((s, f) => s + f.bytes, 0))}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : detailError ? (
            <p className="text-sm text-danger">{detailError}</p>
          ) : null}
        </Inspector>
      </div>

      {zipTarget && (
        <ZipContentsDialog
          torrentId={zipTarget.torrentId}
          provider={providerArg(detailInfo?.provider)}
          fileId={zipTarget.fileId}
          fileName={zipTarget.name}
          torrentName={zipTarget.torrentName}
          onClose={() => setZipTarget(null)}
          onStarted={(root, count) => setNotice(`Downloading ${count} ${count === 1 ? "file" : "files"} from ${zipTarget.name} into ${root}`)}
        />
      )}

      {confirmDeleteAll && (
        <Dialog
          open
          width="sm"
          onOpenChange={(o) => { if (!o && !deletingAll) setConfirmDeleteAll(false); }}
          title="Delete all torrents?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDeleteAll(false)} disabled={deletingAll}>Cancel</Button>
              <Button variant="danger" onClick={() => { void handleDeleteAll(); }} disabled={deletingAll}>
                {deletingAll ? "Deleting..." : "Delete All"}
              </Button>
            </>
          }
        >
          <p className="text-base text-fg">
            Are you sure? This deletes all {torrents.length} {torrents.length === 1 ? "torrent" : "torrents"} from every provider that holds them. This can't be undone.
          </p>
        </Dialog>
      )}

      {/* Add torrent modal */}
      {showAdd && (
        <AddTorrentModal
          onClose={() => setShowAdd(false)}
          onAdded={(notice) => { fetchTorrents(); setNotice(notice); }}
        />
      )}
    </>
  );
}
