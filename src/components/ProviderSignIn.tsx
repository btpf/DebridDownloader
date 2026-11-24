import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuth } from "../hooks/useAuth";
import * as authApi from "../api/auth";
import { providerName } from "../lib/providers";
import { Button, cn, Input } from "./ui";

/**
 * Sign one provider in: an API key, or for Real-Debrid an API token or the OAuth device flow.
 * Used by the sign-in screen and by Settings → Account.
 */
export default function ProviderSignIn({
  providerId,
  authMethod,
  onSignedIn,
}: {
  providerId: string;
  authMethod: "api_key" | "oauth_device";
  /** Called once the provider is signed in (its token saved and the account list refreshed). */
  onSignedIn?: () => void;
}) {
  const { login, refresh } = useAuth();
  const [mode, setMode] = useState<"token" | "oauth">("token");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [userCode, setUserCode] = useState("");
  const [oauthStatus, setOauthStatus] = useState("");
  const name = providerName(providerId);
  const isRd = providerId === "real-debrid";

  const handleTokenLogin = async () => {
    if (!token.trim()) {
      setError(authMethod === "api_key" ? "Please enter your API key" : "Please enter your API token");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await login(token.trim(), providerId);
      onSignedIn?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = async () => {
    setLoading(true);
    setError("");
    setUserCode("");
    setOauthStatus("Requesting device code...");
    try {
      const deviceCode = await authApi.oauthStart();
      setUserCode(deviceCode.user_code);
      setOauthStatus("Opening browser...");
      await openUrl(deviceCode.verification_url);
      setOauthStatus(`Enter the code above on the ${name} page, then wait...`);

      let credentials = null;
      const maxAttempts = Math.floor(deviceCode.expires_in / deviceCode.interval);
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, deviceCode.interval * 1000));
        credentials = await authApi.oauthPollCredentials(deviceCode.device_code);
        if (credentials) break;
      }
      if (!credentials) throw new Error("OAuth authorization timed out");

      setOauthStatus("Getting access token...");
      await authApi.oauthGetToken(credentials.client_id, credentials.client_secret, deviceCode.device_code);
      setOauthStatus("Connected!");
      await refresh();
      onSignedIn?.();
    } catch (e) {
      setError(String(e));
      setOauthStatus("");
      setUserCode("");
    } finally {
      setLoading(false);
    }
  };

  const segClass = (active: boolean) =>
    cn(
      "h-6 flex-1 rounded-sm px-2.5 text-sm font-medium transition-colors duration-120",
      active ? "bg-selected text-fg" : "text-fg-secondary hover:bg-raised hover:text-fg",
    );

  return (
    <div className="flex flex-col gap-4">
      {authMethod === "oauth_device" && (
        <div role="radiogroup" aria-label="Sign-in method" className="flex gap-0.5 rounded-md border border-border p-0.5">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "token"}
            className={segClass(mode === "token")}
            onClick={() => { setMode("token"); setError(""); setUserCode(""); setOauthStatus(""); }}
          >
            API Token
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "oauth"}
            className={segClass(mode === "oauth")}
            onClick={() => { setMode("oauth"); setError(""); }}
          >
            OAuth Login
          </button>
        </div>
      )}

      {authMethod === "api_key" || mode === "token" ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); handleTokenLogin(); }}>
          <span className="text-sm text-fg-muted">{authMethod === "api_key" ? "API Key" : "API Token"}</span>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={authMethod === "api_key" ? `Paste your ${name} API key` : "Paste your token from real-debrid.com/apitoken"}
            aria-label={authMethod === "api_key" ? `${name} API key` : `${name} API token`}
            autoFocus
          />
          <p className="text-sm text-fg-muted">
            {authMethod === "api_key" ? (
              "Enter the API key from your account settings"
            ) : (
              <>
                Get your token at{" "}
                <button type="button" className="text-accent-text hover:underline" onClick={() => openUrl("https://real-debrid.com/apitoken").catch(() => {})}>
                  real-debrid.com/apitoken
                </button>
              </>
            )}
          </p>
          <Button type="submit" variant="primary" disabled={loading} className="mt-2 w-full">
            {loading ? "Connecting..." : "Sign in"}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-secondary">
            Authenticate via {name}'s device authorization. A browser will open for you to approve access.
          </p>
          {userCode && (
            <div className="rounded-md border border-border bg-bg px-4 py-3 text-center">
              <p className="text-sm text-fg-muted">Enter this code on the {name} page:</p>
              <p className="mt-1 font-mono text-xl font-semibold tracking-widest text-fg">{userCode}</p>
            </div>
          )}
          {oauthStatus && <p className="text-center text-sm text-fg-secondary" role="status">{oauthStatus}</p>}
          <Button variant="primary" onClick={handleOAuthLogin} disabled={loading} className="w-full">
            {loading ? "Waiting for authorization..." : isRd ? "Sign in with Real-Debrid" : "Start OAuth Login"}
          </Button>
        </div>
      )}

      {error && <p className="text-center text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
