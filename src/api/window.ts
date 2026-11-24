import { call } from "./transport";

/** Hide the main window to the tray, or quit the app. Desktop only. */
export async function closeMainWindow(action: "tray" | "quit"): Promise<void> {
  await call("close_main_window", { action });
}
