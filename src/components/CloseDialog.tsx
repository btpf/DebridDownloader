import { useEffect, useId, useState } from "react";
import { subscribe } from "../api/transport";
import { getSettings, updateSettings } from "../api/settings";
import { closeMainWindow } from "../api/window";
import { Button, Dialog } from "./ui";

/**
 * Asks what the window's close button should do: quit, hide to the tray, or nothing. The backend
 * sends `close-requested` when `close_action` is "ask"; "Remember my choice" saves the answer as
 * the new `close_action` (changeable in Settings → General).
 */
export default function CloseDialog() {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rememberId = useId();

  useEffect(() => {
    const unlisten = subscribe("close-requested", () => {
      setRemember(false);
      setError("");
      setOpen(true);
    });
    return () => { unlisten.then((f) => f()).catch(() => {}); };
  }, []);

  const choose = async (action: "tray" | "quit") => {
    setBusy(true);
    setError("");
    try {
      if (remember) {
        const settings = await getSettings();
        await updateSettings({ ...settings, close_action: action });
      }
      setOpen(false);
      await closeMainWindow(action);
    } catch (e) {
      setOpen(true);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Dialog
      open
      width="sm"
      onOpenChange={(o) => { if (!o && !busy) setOpen(false); }}
      title="Quit DebridDownloader?"
      description="Exiting to the tray keeps downloads running."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { void choose("tray"); }} disabled={busy}>Exit to Tray</Button>
          <Button variant="danger" onClick={() => { void choose("quit"); }} disabled={busy}>Quit</Button>
        </>
      }
    >
      <label htmlFor={rememberId} className="flex items-center gap-2 text-base text-fg">
        <input
          id={rememberId}
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          disabled={busy}
          className="accent-accent"
        />
        Remember my choice
      </label>
      {remember && <p className="mt-1 text-sm text-fg-muted">You can change this in Settings → General.</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}
