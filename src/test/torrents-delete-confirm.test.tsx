import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #47: in Tauri, tauri-plugin-dialog replaces window.confirm with an async version that
// returns a Promise. Deleting must wait for the answer and do nothing on "No".

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../contexts/MiniPlayerContext", () => ({
  useMiniPlayer: () => ({ openPreview: vi.fn(), loadingTorrentId: null }),
}));
vi.mock("../api/settings", () => ({
  getSettings: vi.fn().mockResolvedValue({ download_folder: "/dl", max_concurrent_downloads: 3, create_torrent_subfolders: true, theme: "dark", provider: "real-debrid" }),
}));
const { torrent, deleteTorrent } = vi.hoisted(() => ({
  torrent: { id: "T1", filename: "Movie.mp4", hash: "abc", bytes: 1000, progress: 100, status: "downloaded", added: "2026-09-20T00:00:00Z", links: ["x"] },
  deleteTorrent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api/torrents", () => ({
  listTorrents: vi.fn().mockImplementation(() => Promise.resolve([torrent])),
  getTorrentInfo: vi.fn().mockResolvedValue({ ...torrent, files: [{ id: 7, path: "/Movie.mp4", bytes: 990, selected: true }] }),
  deleteTorrent: (...args: unknown[]) => deleteTorrent(...args),
  selectTorrentFiles: vi.fn(),
}));

import TorrentsPage from "../pages/TorrentsPage";
import { TooltipProvider } from "../components/ui";
import { confirmAction } from "../lib/confirm";

/** A window.confirm shaped like tauri-plugin-dialog's: returns a Promise we resolve by hand. */
function stubAsyncConfirm() {
  let answer!: (v: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
  vi.stubGlobal("confirm", confirm);
  window.confirm = confirm as unknown as typeof window.confirm;
  return { confirm, answer: (v: boolean) => act(async () => { answer(v); }) };
}

async function renderAndSelect() {
  render(<TooltipProvider><TorrentsPage /></TooltipProvider>);
  fireEvent.click(await screen.findByText("Movie.mp4", { selector: "div" }));
  // Inspector "Delete" button (exact name; the row's More menu is separate).
  return await screen.findByRole("button", { name: "Delete" });
}

describe("Torrent delete confirmation (#47)", () => {
  const realConfirm = window.confirm;
  beforeEach(() => deleteTorrent.mockClear());
  afterEach(() => { vi.unstubAllGlobals(); window.confirm = realConfirm; });

  it("inspector Delete waits for the answer and keeps the torrent on No", async () => {
    const { confirm, answer } = stubAsyncConfirm();
    fireEvent.click(await renderAndSelect());
    expect(confirm).toHaveBeenCalledWith("Delete this torrent?");
    await act(async () => {});
    expect(deleteTorrent).not.toHaveBeenCalled(); // dialog still open
    await answer(false);
    expect(deleteTorrent).not.toHaveBeenCalled();
  });

  it("inspector Delete deletes after Yes", async () => {
    const { answer } = stubAsyncConfirm();
    fireEvent.click(await renderAndSelect());
    await act(async () => {});
    expect(deleteTorrent).not.toHaveBeenCalled();
    await answer(true);
    await waitFor(() => expect(deleteTorrent).toHaveBeenCalledWith("T1", undefined));
  });

  it("delete-selected shortcut waits for the answer and keeps the torrent on No", async () => {
    const { confirm, answer } = stubAsyncConfirm();
    await renderAndSelect();
    act(() => { window.dispatchEvent(new Event("delete-selected")); });
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(deleteTorrent).not.toHaveBeenCalled();
    await answer(false);
    expect(deleteTorrent).not.toHaveBeenCalled();
  });

  it("row More-actions Delete waits for the answer and keeps the torrent on No", async () => {
    const { confirm, answer } = stubAsyncConfirm();
    render(<TooltipProvider><TorrentsPage /></TooltipProvider>);
    const more = await screen.findByRole("button", { name: "More actions" });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete this torrent?");
    await act(async () => {});
    expect(deleteTorrent).not.toHaveBeenCalled();
    await answer(false);
    expect(deleteTorrent).not.toHaveBeenCalled();
  });

  /** Toolbar ⋮ → "Delete All (n)…", which opens the "Are you sure?" dialog. */
  async function openDeleteAll() {
    render(<TooltipProvider><TorrentsPage /></TooltipProvider>);
    await screen.findByText("Movie.mp4", { selector: "div" });
    const more = screen.getByRole("button", { name: "Torrent list actions" });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete All (1)…" }));
    return await screen.findByRole("dialog", { name: "Delete all torrents?" });
  }

  it("toolbar Delete All asks \"Are you sure?\" and keeps torrents on Cancel", async () => {
    const dialog = await openDeleteAll();
    expect(dialog).toHaveTextContent("Are you sure?");
    expect(deleteTorrent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleteTorrent).not.toHaveBeenCalled();
    expect(screen.getByText("Movie.mp4", { selector: "div" })).toBeInTheDocument();
  });

  it("toolbar Delete All deletes every torrent after confirming", async () => {
    const dialog = await openDeleteAll();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete All" }));
    await waitFor(() => expect(deleteTorrent).toHaveBeenCalledWith("T1", undefined));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the toolbar has no Delete All button of its own", async () => {
    render(<TooltipProvider><TorrentsPage /></TooltipProvider>);
    await screen.findByText("Movie.mp4", { selector: "div" });
    expect(screen.queryByRole("button", { name: "Delete All" })).toBeNull();
  });

  it("delete-selected shortcut deletes after Yes", async () => {
    const { answer } = stubAsyncConfirm();
    await renderAndSelect();
    act(() => { window.dispatchEvent(new Event("delete-selected")); });
    await answer(true);
    await waitFor(() => expect(deleteTorrent).toHaveBeenCalledWith("T1", undefined));
  });
});

describe("confirmAction", () => {
  const realConfirm = window.confirm;
  afterEach(() => { window.confirm = realConfirm; });

  it("treats a pending-then-false async confirm as No", async () => {
    window.confirm = (() => Promise.resolve(false)) as unknown as typeof window.confirm;
    await expect(confirmAction("x")).resolves.toBe(false);
  });

  it("accepts async true and sync true/false", async () => {
    window.confirm = (() => Promise.resolve(true)) as unknown as typeof window.confirm;
    await expect(confirmAction("x")).resolves.toBe(true);
    window.confirm = () => true;
    await expect(confirmAction("x")).resolves.toBe(true);
    window.confirm = () => false;
    await expect(confirmAction("x")).resolves.toBe(false);
  });
});
