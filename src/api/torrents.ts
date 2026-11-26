import { call } from "./transport";
import type { AddTorrentResponse, Torrent, TorrentInfo } from "../types";

/** Every torrent on every enabled provider (all pages), one row per torrent across providers. */
export async function listTorrents(): Promise<Torrent[]> {
  return call("list_torrents", {});
}

/** `provider`: the provider `id` belongs to (the primary provider when left out). */
export async function getTorrentInfo(id: string, provider?: string): Promise<TorrentInfo> {
  return call("get_torrent_info", { id, provider: provider ?? null });
}

/**
 * Add to the first provider (priority order) that accepts it, or to every enabled provider when
 * "add to all providers" is on. Every file is selected where it lands, so it starts right away.
 */
export async function addMagnet(magnet: string): Promise<AddTorrentResponse> {
  return call("add_magnet", { magnet });
}

export async function addTorrentFile(
  fileBytes: number[]
): Promise<AddTorrentResponse> {
  return call("add_torrent_file", { fileBytes });
}

export async function selectTorrentFiles(
  id: string,
  fileIds: string,
  provider?: string
): Promise<void> {
  return call("select_torrent_files", { id, fileIds, provider: provider ?? null });
}

/**
 * Start a stuck torrent over: delete each copy and add its magnet (from `hash`) back to the same
 * provider, with every file selected.
 */
export async function retryTorrent(hash: string, copies: { provider: string; id: string }[]): Promise<AddTorrentResponse[]> {
  return call("retry_torrent", { hash, copies });
}

export async function deleteTorrent(id: string, provider?: string): Promise<void> {
  return call("delete_torrent", { id, provider: provider ?? null });
}
