import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccount } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn().mockResolvedValue(null) }));
vi.mock("../contexts/MiniPlayerContext", () => ({
  useMiniPlayer: () => ({ openPreview: vi.fn(), loadingTorrentId: null }),
}));

const { torrentsApi, updateSettings } = vi.hoisted(() => {
  // One torrent on two providers: Real-Debrid (first in priority, still downloading) and
  // AllDebrid (ready), as the backend's merge returns it.
  const merged = {
    id: "A1",
    provider: "alldebrid",
    filename: "Movie.mp4",
    hash: "abc",
    bytes: 1000,
    progress: 100,
    status: "downloaded",
    added: "2026-09-20T00:00:00Z",
    links: ["x"],
    copies: [
      { provider: "real-debrid", id: "R1", status: "downloading", progress: 40 },
      { provider: "alldebrid", id: "A1", status: "downloaded", progress: 100 },
    ],
  };
  return {
    torrentsApi: {
      merged,
      listTorrents: vi.fn().mockImplementation(() => Promise.resolve([merged])),
      getTorrentInfo: vi.fn().mockResolvedValue({ ...merged, files: [] }),
      deleteTorrent: vi.fn().mockResolvedValue(undefined),
      selectTorrentFiles: vi.fn(),
      addTorrentFile: vi.fn().mockResolvedValue({ id: "new", provider: "real-debrid" }),
    },
    updateSettings: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../api/torrents", () => torrentsApi);
vi.mock("../api/settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    download_folder: "/dl",
    max_concurrent_downloads: 3,
    create_torrent_subfolders: true,
    theme: "dark",
    provider: "real-debrid",
    add_to_all_providers: false,
  }),
  updateSettings: (...args: unknown[]) => updateSettings(...args),
}));

import TorrentsPage from "../pages/TorrentsPage";
import AccountSettings from "../pages/settings/AccountSettings";
import { SettingsProvider } from "../pages/settings/useSettings";
import Sidebar from "../components/Sidebar";
import TorrentDropZone from "../components/TorrentDropZone";
import { AuthContext, type AuthState } from "../hooks/useAuth";
import { TooltipProvider } from "../components/ui";

const account = (id: string, name: string, enabled: boolean, authenticated: boolean): ProviderAccount => ({
  id,
  name,
  auth_method: id === "real-debrid" ? "oauth_device" : "api_key",
  enabled,
  authenticated,
  user: authenticated ? { username: `${id}-user`, email: "", premium: true, expiration: null } : null,
});

const ACCOUNTS = [
  account("alldebrid", "AllDebrid", true, true),
  account("real-debrid", "Real-Debrid", true, true),
  account("torbox", "TorBox", false, false),
  account("premiumize", "Premiumize", false, true),
];

function auth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    isAuthenticated: true,
    user: null,
    accounts: ACCOUNTS,
    loading: false,
    login: vi.fn(),
    loginOAuth: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Torrents list across providers", () => {
  const realConfirm = window.confirm;
  afterEach(() => { window.confirm = realConfirm; });

  it("shows a Provider column naming every provider that holds the torrent", async () => {
    render(<TooltipProvider><TorrentsPage /></TooltipProvider>);
    await screen.findByText("Movie.mp4", { selector: "div" });
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getAllByText("Real-Debrid").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AllDebrid").length).toBeGreaterThan(0);
  });

  it("opens the ready copy and deletes every copy from its own provider", async () => {
    window.confirm = vi.fn(() => true);
    render(<TooltipProvider><TorrentsPage /></TooltipProvider>);
    fireEvent.click(await screen.findByText("Movie.mp4", { selector: "div" }));
    await waitFor(() => expect(torrentsApi.getTorrentInfo).toHaveBeenCalledWith("A1", "alldebrid"));

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(window.confirm).toHaveBeenCalledWith("Delete this torrent from Real-Debrid, AllDebrid?");
    await waitFor(() => expect(torrentsApi.deleteTorrent).toHaveBeenCalledTimes(2));
    expect(torrentsApi.deleteTorrent).toHaveBeenCalledWith("R1", "real-debrid");
    expect(torrentsApi.deleteTorrent).toHaveBeenCalledWith("A1", "alldebrid");
  });
});

describe("Account settings", () => {
  function renderAccounts(state = auth()) {
    render(
      <TooltipProvider>
        <AuthContext.Provider value={state}>
          <SettingsProvider>
            <AccountSettings />
          </SettingsProvider>
        </AuthContext.Provider>
      </TooltipProvider>,
    );
    return state;
  }

  it("lists every provider in priority order with one sign-in/out button each", async () => {
    renderAccounts();
    const rows = within(screen.getByRole("list", { name: "Providers in priority order" })).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["AllDebrid", "Real-Debrid", "TorBox", "Premiumize"]);
    expect(within(rows[0]).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(rows[2]).getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(within(rows[0]).getByRole("switch", { name: "Enable AllDebrid" })).toHaveAttribute("aria-checked", "true");
    expect(within(rows[2]).getByRole("switch", { name: "Enable TorBox" })).toHaveAttribute("aria-checked", "false");
  });

  it("reordering saves the new priority list", async () => {
    const state = renderAccounts();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Add torrents to all providers" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Move AllDebrid down" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls[0][0].providers).toEqual([
      { id: "real-debrid", enabled: true },
      { id: "alldebrid", enabled: true },
      { id: "torbox", enabled: false },
      { id: "premiumize", enabled: false },
    ]);
    expect(state.refresh).toHaveBeenCalled();
  });

  it("enabling a provider and the add-to-all toggle save their settings", async () => {
    renderAccounts();
    const toAll = screen.getByRole("switch", { name: "Add torrents to all providers" });
    await waitFor(() => expect(toAll).not.toBeDisabled());
    fireEvent.click(screen.getByRole("switch", { name: "Enable TorBox" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0][0].providers[2]).toEqual({ id: "torbox", enabled: true });

    fireEvent.click(toAll);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings.mock.calls[1][0].add_to_all_providers).toBe(true);
  });

  it("signs out only that provider", async () => {
    const state = renderAccounts();
    const row = screen.getAllByRole("listitem")[1];
    fireEvent.click(within(row).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(state.logout).toHaveBeenCalledWith("real-debrid"));
  });
});

describe("Sidebar accounts", () => {
  it("lists each enabled provider with a dot", () => {
    render(
      <TooltipProvider>
        <AuthContext.Provider value={auth()}>
          <Sidebar activeView="torrents" onNavigate={() => {}} onSearchOpen={() => {}} onSettingsOpen={() => {}} onAboutOpen={() => {}} />
        </AuthContext.Provider>
      </TooltipProvider>,
    );
    const button = screen.getByRole("button", { name: /^Accounts:/ });
    expect(within(button).getByText("AllDebrid")).toBeInTheDocument();
    expect(within(button).getByText("Real-Debrid")).toBeInTheDocument();
    // Disabled providers stay out of the sidebar, signed in or not.
    expect(within(button).queryByText("Premiumize")).toBeNull();
    expect(within(button).queryByText("TorBox")).toBeNull();
  });
});

describe("Dropping .torrent files", () => {
  function drop(files: File[], types = ["Files"]) {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types, files, dropEffect: "none" } });
    act(() => { window.dispatchEvent(event); });
    return event;
  }

  it("adds each dropped .torrent file and skips other files", async () => {
    render(<TorrentDropZone />);
    const refresh = vi.fn();
    window.addEventListener("refresh-list", refresh);
    const torrent = new File([new Uint8Array([1, 2, 3])], "show.torrent");
    const other = new File(["x"], "notes.txt");
    const event = drop([torrent, other]);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(torrentsApi.addTorrentFile).toHaveBeenCalledWith([1, 2, 3]));
    expect(torrentsApi.addTorrentFile).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Added 1 torrent")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    window.removeEventListener("refresh-list", refresh);
  });

  it("leaves drags without files alone (reordering, text)", () => {
    render(<TorrentDropZone />);
    const event = drop([], ["text/plain"]);
    expect(event.defaultPrevented).toBe(false);
    expect(torrentsApi.addTorrentFile).not.toHaveBeenCalled();
  });
});
