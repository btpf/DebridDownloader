import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { AuthContext, primaryUser, type AuthState } from "./hooks/useAuth";
import { useMagnetLinkListener } from "./hooks/useMagnetLinkListener";
import * as authApi from "./api/auth";
import * as torrentsApi from "./api/torrents";
import { getProviderAccounts } from "./api/providers";
import type { ProviderAccount } from "./types";

import { MiniPlayerProvider, useMiniPlayer } from "./contexts/MiniPlayerContext";
import MiniPlayer from "./components/MiniPlayer";
import Toast from "./components/Toast";
import Layout from "./components/Layout";
import { TooltipProvider } from "./components/ui";
import AuthPage from "./pages/AuthPage";
import TorrentsPage from "./pages/TorrentsPage";
import DownloadsPage from "./pages/DownloadsPage";
import CompletedPage from "./pages/CompletedPage";
import SearchPage from "./pages/SearchPage";
import WatchListPage from "./pages/WatchListPage";
import StatisticsPage from "./pages/StatisticsPage";
import CloseDialog from "./components/CloseDialog";
import { settingsRoutes } from "./pages/settings/SettingsLayout";

const navigateRef: { current: ReturnType<typeof useNavigate> | null } = { current: null };

function NavigateRefSetter() {
  navigateRef.current = useNavigate();
  return null;
}

function MiniPlayerToast() {
  const { toastMessage, dismissToast } = useMiniPlayer();
  if (!toastMessage) return null;
  return <Toast message={toastMessage} onDismiss={dismissToast} />;
}

function MiniPlayerLogoutCleanup() {
  const auth = useContext(AuthContext);
  const { closePreview } = useMiniPlayer();
  const prevAuth = useRef(auth?.isAuthenticated);

  useEffect(() => {
    if (prevAuth.current && !auth?.isAuthenticated) {
      closePreview();
    }
    prevAuth.current = auth?.isAuthenticated;
  }, [auth?.isAuthenticated, closePreview]);

  return null;
}

function App() {
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const isAuthenticated = accounts.some((a) => a.authenticated);
  const user = primaryUser(accounts);
  const [loading, setLoading] = useState(true);
  const [magnetError, setMagnetError] = useState<string | null>(null);

  const clearCurrentUriRef = { current: () => {} };

  const handleMagnetLink = useCallback(
    (event: { uri: string; displayName: string | null }) => {
      // The backend selects every file where the torrent lands, so it starts right away.
      torrentsApi.addMagnet(event.uri).then(() => {
        clearCurrentUriRef.current();
        navigateRef.current?.("/torrents");
      }).catch((e) => {
        console.error("Failed to add magnet:", e);
        setMagnetError(`Couldn't add magnet link: ${String(e)}`);
      });
    },
    []
  );

  const { clearCurrentUri } = useMagnetLinkListener(
    handleMagnetLink,
    isAuthenticated
  );
  clearCurrentUriRef.current = clearCurrentUri;

  const refresh = useCallback(async () => {
    try {
      setAccounts(await getProviderAccounts());
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        await authApi.loadSavedToken();
        await refresh();
      } catch {
        // no saved token
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [refresh]);

  const login = async (token: string, providerId?: string) => {
    await authApi.setApiToken(token, providerId);
    await refresh();
  };

  const loginOAuth = async () => {
    const deviceCode = await authApi.oauthStart();

    // Open browser for user to authorize
    window.open(deviceCode.verification_url, "_blank");

    // Poll for credentials
    let credentials = null;
    const maxAttempts = Math.floor(deviceCode.expires_in / deviceCode.interval);

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, deviceCode.interval * 1000));
      credentials = await authApi.oauthPollCredentials(
        deviceCode.device_code
      );
      if (credentials) break;
    }

    if (!credentials) {
      throw new Error("OAuth authorization timed out");
    }

    // Exchange for token
    await authApi.oauthGetToken(
      credentials.client_id,
      credentials.client_secret,
      deviceCode.device_code
    );

    await refresh();
  };

  const logout = async (providerId?: string) => {
    await authApi.logout(providerId);
    await refresh();
  };

  const authState: AuthState = {
    isAuthenticated,
    user,
    accounts,
    loading,
    login,
    loginOAuth,
    logout,
    refresh,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="text-fg-muted text-base">Loading...</div>
      </div>
    );
  }

  return (
    <TooltipProvider>
    <MiniPlayerProvider>
      <AuthContext.Provider value={authState}>
        <BrowserRouter>
        <NavigateRefSetter />
        <Routes>
          {!isAuthenticated ? (
            <>
              <Route path="/auth" element={<AuthPage />} />
              <Route path="*" element={<Navigate to="/auth" replace />} />
            </>
          ) : (
            <>
              <Route element={<Layout />}>
                <Route path="/torrents" element={<TorrentsPage />} />
                <Route path="/downloads" element={<DownloadsPage />} />
                <Route path="/completed" element={<CompletedPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/watchlist" element={<WatchListPage />} />
                <Route path="/statistics" element={<StatisticsPage />} />
                {settingsRoutes}
                <Route path="*" element={<Navigate to="/torrents" replace />} />
              </Route>
            </>
          )}
        </Routes>
        </BrowserRouter>
        <MiniPlayer />
        <MiniPlayerToast />
        {magnetError && <Toast message={magnetError} duration={6000} onDismiss={() => setMagnetError(null)} />}
        <MiniPlayerLogoutCleanup />
        <CloseDialog />
      </AuthContext.Provider>
    </MiniPlayerProvider>
    </TooltipProvider>
  );
}

export default App;
