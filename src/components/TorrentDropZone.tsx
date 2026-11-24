import { useEffect, useRef, useState } from "react";
import * as torrentsApi from "../api/torrents";
import Toast from "./Toast";

const isTorrentFile = (f: File) => f.name.toLowerCase().endsWith(".torrent");
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Drop `.torrent` files anywhere in the window to add them (following the account settings:
 * the first provider that takes each, or every enabled provider). Works in the Tauri window
 * (`dragDropEnabled: false` in tauri.conf.json hands file drops to the page) and in the browser UI.
 * Drags that carry no files (reordering lists, selected text) are left alone.
 */
export default function TorrentDropZone() {
  const [over, setOver] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const depth = useRef(0);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      void addFiles(Array.from(e.dataTransfer?.files ?? []));
    };

    const addFiles = async (files: File[]) => {
      const torrents = files.filter(isTorrentFile);
      if (torrents.length === 0) {
        setMessage("Only .torrent files can be dropped here");
        return;
      }
      const failures: string[] = [];
      let added = 0;
      for (const file of torrents) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await torrentsApi.addTorrentFile(Array.from(bytes));
          added += 1;
        } catch (err) {
          failures.push(`${file.name}: ${String(err)}`);
        }
      }
      if (added > 0) window.dispatchEvent(new Event("refresh-list"));
      const ok = added > 0 ? `Added ${added} ${added === 1 ? "torrent" : "torrents"}` : "";
      setMessage([ok, ...failures].filter(Boolean).join(". "));
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <>
      {over && (
        <div
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-6"
          role="status"
          aria-live="polite"
        >
          <div className="flex size-full items-center justify-center rounded-lg border-2 border-dashed border-accent">
            <p className="text-lg font-semibold text-fg">Drop .torrent files to add them</p>
          </div>
        </div>
      )}
      {message && <Toast message={message} duration={6000} onDismiss={() => setMessage(null)} />}
    </>
  );
}
