import { SettingsGroup, SettingsRow, Toggle } from "../../components/ui";
import { useSettings } from "./useSettings";

export default function AdvancedSettings() {
  const { settings, applyChange, savedField, markSaved } = useSettings();
  if (!settings) return null;
  // Missing in settings saved before this option existed; the backend treats that as on.
  const sparse = settings.sparse_downloads ?? true;

  return (
    <SettingsGroup title="Disk">
      <SettingsRow
        label="Sparse download files"
        description="On: files grow as they download, and pausing or cancelling is immediate. Off: the full file size is reserved on the drive first. On Windows the drive then has to write zeros ahead of each connection; for large files on slow drives that can take a long time, and the download can't be paused, cancelled or quit until it finishes. Applies to downloads that start after the change."
        saved={savedField === "sparse_downloads"}
      >
        <Toggle
          label="Sparse download files"
          checked={sparse}
          onChange={async (v) => {
            await applyChange({ sparse_downloads: v });
            markSaved("sparse_downloads");
          }}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
