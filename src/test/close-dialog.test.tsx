import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

const { handlers, closeMainWindow, getSettings, updateSettings } = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  closeMainWindow: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));
vi.mock("../api/window", () => ({ closeMainWindow }));
vi.mock("../api/settings", () => ({ getSettings, updateSettings }));

import CloseDialog from "../components/CloseDialog";

const SETTINGS = { download_folder: "/dl", theme: "dark", close_action: "ask" };

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(SETTINGS);
});

async function clickClose() {
  render(<CloseDialog />);
  await waitFor(() => expect(handlers.has("close-requested")).toBe(true));
  act(() => handlers.get("close-requested")!({ payload: null }));
  return screen.findByRole("dialog", { name: "Quit DebridDownloader?" });
}

describe("Close dialog", () => {
  it("stays hidden until the close button is clicked", () => {
    render(<CloseDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Quit quits without saving anything when Remember is unticked", async () => {
    await clickClose();
    expect(screen.getByRole("checkbox", { name: "Remember my choice" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Quit" }));
    await waitFor(() => expect(closeMainWindow).toHaveBeenCalledWith("quit"));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("Exit to Tray with Remember ticked saves the choice, then hides the window", async () => {
    await clickClose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit to Tray" }));
    await waitFor(() => expect(closeMainWindow).toHaveBeenCalledWith("tray"));
    expect(updateSettings).toHaveBeenCalledWith({ ...SETTINGS, close_action: "tray" });
    expect(updateSettings.mock.invocationCallOrder[0]).toBeLessThan(closeMainWindow.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel closes the dialog and leaves the window open", async () => {
    await clickClose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(closeMainWindow).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("asks afresh each time, with Remember unticked", async () => {
    await clickClose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => handlers.get("close-requested")!({ payload: null }));
    expect(await screen.findByRole("checkbox", { name: "Remember my choice" })).not.toBeChecked();
  });
});
