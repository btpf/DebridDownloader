import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { addMagnet } = vi.hoisted(() => ({ addMagnet: vi.fn() }));
vi.mock("../api/torrents", () => ({ addMagnet, addTorrentFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import AddTorrentModal from "../components/AddTorrentModal";
import { rejectedNotice } from "../lib/providers";

describe("rejectedNotice", () => {
  it("is empty when every provider took the torrent", () => {
    expect(rejectedNotice({ id: "1", provider: "torbox" })).toBe("");
    expect(rejectedNotice({ id: "1", provider: "torbox", rejected: [] })).toBe("");
  });

  it("names each provider that turned it down", () => {
    expect(rejectedNotice({ id: "1", provider: "torbox", rejected: ["AllDebrid: File not available due to no peer"] }))
      .toBe("Not added to AllDebrid: File not available due to no peer");
    expect(rejectedNotice({ id: "1", provider: "torbox", rejected: ["AllDebrid: a", "Premiumize: b"] }))
      .toBe("Not added to AllDebrid: a; Premiumize: b");
  });
});

describe("AddTorrentModal", () => {
  it("hands the rejection notice to onAdded", async () => {
    addMagnet.mockResolvedValue({ id: "1", provider: "torbox", rejected: ["AllDebrid: No peers"] });
    const onAdded = vi.fn();
    render(<AddTorrentModal onClose={() => {}} onAdded={onAdded} initialMagnet="magnet:?xt=urn:btih:abc" />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("Not added to AllDebrid: No peers"));
  });
});
