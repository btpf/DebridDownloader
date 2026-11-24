import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccount, Torrent } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

const { listTorrents } = vi.hoisted(() => ({ listTorrents: vi.fn() }));
vi.mock("../api/torrents", () => ({ listTorrents }));

import StatisticsPage, { libraryHits } from "../pages/StatisticsPage";
import { AuthContext, type AuthState } from "../hooks/useAuth";
import { TooltipProvider } from "../components/ui";
import { getCachedTorrents, setCachedTorrents } from "../lib/torrentsCache";

const account = (id: string, name: string, enabled = true, authenticated = true): ProviderAccount => ({
  id, name, auth_method: "api_key", enabled, authenticated, user: null,
});
const ACCOUNTS = [
  account("real-debrid", "Real-Debrid"),
  account("alldebrid", "AllDebrid"),
  account("torbox", "TorBox"),
  account("premiumize", "Premiumize", false),
];

const copy = (provider: string, status = "downloaded") => ({ provider, id: `${provider}-id`, status, progress: 100 });
const torrent = (name: string, copies: ReturnType<typeof copy>[]): Torrent => ({
  id: copies[0].id, provider: copies[0].provider, filename: name, hash: "", bytes: 1, progress: 100,
  status: copies[0].status, added: "2026-11-01T00:00:00Z", links: [], copies,
} as Torrent);

// Four torrents, however they got there: two only on Real-Debrid (one still downloading), one on
// Real-Debrid and AllDebrid, one only on AllDebrid.
const LIBRARY = [
  torrent("A", [copy("real-debrid")]),
  torrent("B", [copy("real-debrid", "downloading")]),
  torrent("C", [copy("real-debrid"), copy("alldebrid")]),
  torrent("D", [copy("alldebrid")]),
];

function page() {
  const auth = { isAuthenticated: true, user: null, accounts: ACCOUNTS, loading: false } as unknown as AuthState;
  return (
    <TooltipProvider>
      <AuthContext.Provider value={auth}>
        <StatisticsPage />
      </AuthContext.Provider>
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listTorrents.mockResolvedValue(LIBRARY);
});

describe("libraryHits", () => {
  it("counts every torrent each provider holds, and how many are ready", () => {
    expect(libraryHits(LIBRARY, [{ id: "real-debrid", name: "RD" }, { id: "alldebrid", name: "AD" }, { id: "torbox", name: "TB" }])).toEqual([
      { provider: "real-debrid", name: "RD", hits: 3, ready: 2 },
      { provider: "alldebrid", name: "AD", hits: 2, ready: 2 },
      { provider: "torbox", name: "TB", hits: 0, ready: 0 },
    ]);
  });
});

describe("Statistics page", () => {
  it("draws the library's hits by enabled provider and lists them", async () => {
    render(page());
    const pie = await screen.findByRole("img", { name: /Hits by provider/ });
    expect(pie).toHaveAccessibleName("Hits by provider: Real-Debrid 3 (60%), AllDebrid 2 (40%)");
    expect(pie.querySelectorAll("path")).toHaveLength(2);

    const table = screen.getByRole("table", { name: "Library torrents by provider" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
    // Premiumize is disabled, so it's left out; TorBox is enabled but holds nothing.
    expect(rows).toEqual(["Real-Debrid375%2", "AllDebrid250%2", "TorBox00%0"]);
    expect(screen.getByText("4 torrents in the library")).toBeInTheDocument();
    // The Torrents tab reuses what this page fetched.
    expect(getCachedTorrents()?.torrents).toEqual(LIBRARY);
  });

  it("uses the Torrents tab's cached list without fetching", async () => {
    setCachedTorrents(LIBRARY, "real-debrid,alldebrid,torbox");
    render(page());
    expect(screen.getByRole("img", { name: /Hits by provider/ })).toBeInTheDocument();
    await act(async () => {});
    expect(listTorrents).not.toHaveBeenCalled();
  });

  it("Refresh fetches the library again", async () => {
    render(page());
    await screen.findByRole("img", { name: /Hits by provider/ });
    listTorrents.mockResolvedValue([torrent("E", [copy("torbox")])]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAccessibleName("Hits by provider: TorBox 1 (100%)"));
    expect(screen.getByRole("img").querySelectorAll("circle")).toHaveLength(1);
  });

  it("shows an empty state when the library is empty", async () => {
    listTorrents.mockResolvedValue([]);
    render(page());
    expect(await screen.findByText("No torrents yet")).toBeInTheDocument();
  });
});
