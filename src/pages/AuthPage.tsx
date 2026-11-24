import { useEffect, useState } from "react";
import { getActiveProvider, getAvailableProviders } from "../api/providers";
import type { ProviderInfo } from "../types";
import { useAppearance } from "../hooks/useAppearance";
import { providerName } from "../lib/providers";
import ProviderSignIn from "../components/ProviderSignIn";
import { Select } from "../components/ui";

/** Shown while no provider is signed in. More providers can be added later under Settings → Account. */
export default function AuthPage() {
  // Theme + accent must apply before sign-in too (Layout isn't mounted here).
  useAppearance();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState("real-debrid");

  useEffect(() => {
    getAvailableProviders().then(setProviders).catch(() => {});
    getActiveProvider().then(setProviderId).catch(() => {});
  }, []);

  const authMethod = providers.find((p) => p.id === providerId)?.auth_method ?? (providerId === "real-debrid" ? "oauth_device" : "api_key");

  return (
    <div className="flex h-screen items-center justify-center bg-bg">
      <div className="flex w-96 flex-col gap-5 rounded-lg border border-border bg-surface p-6 shadow-panel">
        {/* Header */}
        <div className="flex flex-col items-center gap-1 text-center">
          <img src="/app-icon.png" alt="" className="mb-2 size-10 rounded-lg" />
          <h1 className="text-xl font-semibold text-fg">DebridDownloader</h1>
          <p className="text-sm text-fg-secondary">Connect your {providerName(providerId)} account</p>
        </div>

        {/* Provider picker */}
        {providers.length > 1 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-base text-fg">Provider</span>
            <Select
              ariaLabel="Provider"
              value={providerId}
              onValueChange={setProviderId}
              options={providers.map((p) => ({ value: p.id, label: providerName(p.id) }))}
            />
          </div>
        )}

        {/* Signing in refreshes the account list, which swaps this page for the app. */}
        <ProviderSignIn key={providerId} providerId={providerId} authMethod={authMethod} />

        <p className="text-center text-sm text-fg-muted">You can add more providers later in Settings → Account.</p>
      </div>
    </div>
  );
}
