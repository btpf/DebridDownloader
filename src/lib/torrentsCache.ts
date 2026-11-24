import type { Torrent } from "../types";

/**
 * The Torrents list, kept across visits to the Torrents tab so opening it again shows the rows
 * straight away instead of a spinner and a new request. `providers` is the set of enabled,
 * signed-in providers the list was fetched with; when that changes the list is fetched again.
 */
export interface CachedTorrents {
  torrents: Torrent[];
  providers: string;
}

let cache: CachedTorrents | null = null;

export function getCachedTorrents(): CachedTorrents | null {
  return cache;
}

/** Store a freshly fetched list. */
export function setCachedTorrents(torrents: Torrent[], providers: string) {
  cache = { torrents, providers };
}

/** Keep the cache in step with local edits (a delete) without changing what it was fetched for. */
export function updateCachedTorrents(torrents: Torrent[]) {
  if (cache) cache = { ...cache, torrents };
}

export function clearTorrentsCache() {
  cache = null;
}
