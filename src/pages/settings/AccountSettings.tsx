import { useState, type DragEvent } from "react";
import { premiumDaysLeft, useAuth } from "../../hooks/useAuth";
import { providerName } from "../../lib/providers";
import type { ProviderAccount, ProviderPref } from "../../types";
import ProviderSignIn from "../../components/ProviderSignIn";
import { Button, cn, Dialog, IconButton, SettingsGroup, SettingsRow, StatusDot, Toggle } from "../../components/ui";
import { useSettings } from "./useSettings";

const GripIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
);

const ChevronIcon = ({ up }: { up?: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points={up ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
  </svg>
);

/** "username · Premium · 62 days left", or why there's no account. */
function accountLine(a: ProviderAccount): string {
  if (!a.authenticated) return "Not signed in";
  const days = premiumDaysLeft(a.user);
  return [a.user?.username, a.user ? (a.user.premium ? "Premium" : "Free") : "Signed in", days !== null ? `${days} days left` : null]
    .filter(Boolean)
    .join(" · ");
}

function accountDot(a: ProviderAccount): "success" | "warning" | "idle" {
  if (!a.authenticated) return "idle";
  return a.user && !a.user.premium ? "warning" : "success";
}

export default function AccountSettings() {
  const { accounts, logout, refresh } = useAuth();
  const { settings, applyChange, reload, markSaved, savedField } = useSettings();
  const [signingIn, setSigningIn] = useState<ProviderAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** Persist a new priority list / enabled flags, then reload the account list. */
  const savePrefs = async (next: ProviderAccount[]) => {
    setError("");
    try {
      const providers: ProviderPref[] = next.map((a) => ({ id: a.id, enabled: a.enabled }));
      await applyChange({ providers });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= accounts.length || from === to) return;
    const next = [...accounts];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    void savePrefs(next);
  };

  const setEnabled = (id: string, enabled: boolean) => {
    void savePrefs(accounts.map((a) => (a.id === id ? { ...a, enabled } : a)));
  };

  const signOut = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await logout(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDragStart = (id: string) => (e: DragEvent) => {
    setDragging(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onDragOver = (id: string) => (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  };
  const onDrop = (id: string) => (e: DragEvent) => {
    e.preventDefault();
    const from = accounts.findIndex((a) => a.id === dragging);
    const to = accounts.findIndex((a) => a.id === id);
    setDragging(null);
    setDropTarget(null);
    if (from >= 0 && to >= 0) move(from, to);
  };
  const onDragEnd = () => { setDragging(null); setDropTarget(null); };

  return (
    <>
      <SettingsGroup title="Providers">
        <p className="px-3 pt-1 text-sm text-fg-muted">
          Drag to set the order providers are tried in. Torrents from every enabled provider are listed together.
        </p>
        <ol aria-label="Providers in priority order" className="divide-y divide-border-subtle">
          {accounts.map((a, i) => (
            <li
              key={a.id}
              draggable
              onDragStart={onDragStart(a.id)}
              onDragOver={onDragOver(a.id)}
              onDrop={onDrop(a.id)}
              onDragEnd={onDragEnd}
              aria-label={providerName(a.id)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 transition-colors duration-120",
                dragging === a.id && "opacity-50",
                dropTarget === a.id && dragging !== a.id && "bg-selected",
              )}
            >
              <span className="cursor-grab text-fg-muted" aria-hidden>
                <GripIcon />
              </span>
              <span className="w-4 shrink-0 text-sm text-fg-muted tabular" aria-hidden>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <StatusDot status={accountDot(a)}>
                  <span className={cn("text-base", a.enabled ? "text-fg" : "text-fg-muted")}>{providerName(a.id)}</span>
                </StatusDot>
                <p className="mt-0.5 truncate text-sm text-fg-muted">{accountLine(a)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <IconButton size="sm" label={`Move ${providerName(a.id)} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ChevronIcon up />
                </IconButton>
                <IconButton size="sm" label={`Move ${providerName(a.id)} down`} disabled={i === accounts.length - 1} onClick={() => move(i, i + 1)}>
                  <ChevronIcon />
                </IconButton>
              </div>
              <Toggle label={`Enable ${providerName(a.id)}`} checked={a.enabled} onChange={(v) => setEnabled(a.id, v)} />
              <div className="flex w-20 shrink-0 justify-end">
                {a.authenticated ? (
                  <Button variant="danger" size="sm" disabled={busy === a.id} onClick={() => { void signOut(a.id); }}>
                    Sign out
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => setSigningIn(a)}>
                    Sign in
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
        {error && <p className="px-3 pb-2.5 text-sm text-danger" role="alert">{error}</p>}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label="Add torrents to all providers"
          description="Add each torrent to every enabled provider at once. When off, the first provider in the list gets it, and the next one down is tried if that fails."
          saved={savedField === "add_to_all_providers"}
        >
          <Toggle
            label="Add torrents to all providers"
            checked={settings?.add_to_all_providers ?? false}
            disabled={!settings}
            onChange={async (v) => {
              await applyChange({ add_to_all_providers: v });
              markSaved("add_to_all_providers");
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {signingIn && (
        <Dialog
          open
          onOpenChange={(o) => { if (!o) setSigningIn(null); }}
          title={`Sign in to ${providerName(signingIn.id)}`}
          description="Signing in also enables the provider."
        >
          <ProviderSignIn
            providerId={signingIn.id}
            authMethod={signingIn.auth_method}
            onSignedIn={() => {
              setSigningIn(null);
              // Signing in enabled the provider in the backend; pick that up before the next save.
              void reload();
            }}
          />
        </Dialog>
      )}
    </>
  );
}
