import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const SETTINGS = { download_folder: "/dl", theme: "dark", max_concurrent_downloads: 3 };

vi.mock("../api/settings", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

import { getSettings, updateSettings } from "../api/settings";
import { SettingsProvider } from "../pages/settings/useSettings";
import AdvancedSettings from "../pages/settings/AdvancedSettings";

function show(settings: object) {
  vi.mocked(getSettings).mockResolvedValue(settings as never);
  render(
    <SettingsProvider>
      <AdvancedSettings />
    </SettingsProvider>,
  );
}

describe("Advanced settings", () => {
  it("has sparse download files on for settings saved before the option existed", async () => {
    show(SETTINGS);
    const toggle = await screen.findByRole("switch", { name: "Sparse download files" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("turning it off saves sparse_downloads: false", async () => {
    show({ ...SETTINGS, sparse_downloads: true });
    fireEvent.click(await screen.findByRole("switch", { name: "Sparse download files" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ ...SETTINGS, sparse_downloads: false }));
    expect(screen.getByRole("switch", { name: "Sparse download files" })).toHaveAttribute("aria-checked", "false");
  });
});
