import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

const { statsApi } = vi.hoisted(() => ({
  statsApi: {
    getProviderStats: vi.fn(),
    resetProviderStats: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../api/stats", () => statsApi);

import StatisticsPage from "../pages/StatisticsPage";

const STATS = [
  { provider: "real-debrid", name: "Real-Debrid", hits: 6, misses: 2 },
  { provider: "alldebrid", name: "AllDebrid", hits: 2, misses: 0 },
  { provider: "torbox", name: "TorBox", hits: 0, misses: 0 },
  { provider: "premiumize", name: "Premiumize", hits: 0, misses: 3 },
];

beforeEach(() => {
  vi.clearAllMocks();
  statsApi.getProviderStats.mockResolvedValue(STATS);
});

describe("Statistics page", () => {
  it("draws one pie slice per provider with hits and lists hits, share, misses and hit rate", async () => {
    render(<StatisticsPage />);
    const pie = await screen.findByRole("img", { name: /Hits by provider/ });
    expect(pie).toHaveAccessibleName("Hits by provider: Real-Debrid 6 (75%), AllDebrid 2 (25%)");
    expect(pie.querySelectorAll("path")).toHaveLength(2);

    const table = screen.getByRole("table", { name: "Hits and misses by provider" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
    // TorBox was never tried, so it stays out; Premiumize only missed.
    expect(rows).toEqual([
      "Real-Debrid675%275%",
      "AllDebrid225%0100%",
      "Premiumize00%30%",
    ]);
    expect(screen.getByText("8 torrents added")).toBeInTheDocument();
  });

  it("draws a whole circle when only one provider has hits", async () => {
    statsApi.getProviderStats.mockResolvedValue([{ provider: "torbox", name: "TorBox", hits: 3, misses: 1 }]);
    render(<StatisticsPage />);
    const pie = await screen.findByRole("img", { name: /Hits by provider/ });
    expect(pie.querySelectorAll("circle")).toHaveLength(1);
  });

  it("shows an empty state before anything was added", async () => {
    statsApi.getProviderStats.mockResolvedValue(STATS.map((s) => ({ ...s, hits: 0, misses: 0 })));
    render(<StatisticsPage />);
    expect(await screen.findByText("No statistics yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset…" })).toBeDisabled();
  });

  it("resets only after confirming", async () => {
    render(<StatisticsPage />);
    await screen.findByRole("img", { name: /Hits by provider/ });
    fireEvent.click(screen.getByRole("button", { name: "Reset…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset statistics?" });
    expect(statsApi.resetProviderStats).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(statsApi.resetProviderStats).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(statsApi.getProviderStats).toHaveBeenCalledTimes(2));
  });
});
