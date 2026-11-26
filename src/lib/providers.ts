import type { AddTorrentResponse, Torrent, TorrentCopy } from "../types";

export const PROVIDER_NAMES: Record<string, string> = {
  "real-debrid": "Real-Debrid",
  torbox: "TorBox",
  premiumize: "Premiumize",
  alldebrid: "AllDebrid",
};

export function providerName(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

/** Every provider copy of a listed torrent; a row without `copies` stands for itself. */
export function torrentCopies(t: Torrent): TorrentCopy[] {
  if (t.copies?.length) return t.copies;
  return [{ provider: t.provider ?? "", id: t.id, status: t.status, progress: t.progress }];
}

/**
 * Stable key of a torrents-list row: its highest-priority copy. (`id`/`provider` follow the copy
 * to act on, which changes when another provider finishes first.)
 */
export function torrentKey(t: Torrent): string {
  const first = torrentCopies(t)[0];
  return `${first.provider}:${first.id}`;
}

/**
 * What to tell the user when an add landed somewhere but some providers turned it down, e.g.
 * "Not added to AllDebrid: File not available due to no peer". Empty when every provider took it.
 */
export function rejectedNotice(res: AddTorrentResponse): string {
  const rejected = res.rejected ?? [];
  return rejected.length > 0 ? `Not added to ${rejected.join("; ")}` : "";
}
