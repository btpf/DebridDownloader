import { createContext, useContext } from "react";
import type { ProviderAccount, User } from "../types";

export interface AuthState {
  /** True while any provider is signed in. */
  isAuthenticated: boolean;
  /** Account of the highest-priority enabled, signed-in provider. */
  user: User | null;
  /** Every provider in priority order (see `getProviderAccounts`). */
  accounts: ProviderAccount[];
  loading: boolean;
  /** Sign `providerId` in with an API token (the primary provider when left out). */
  login: (token: string, providerId?: string) => Promise<void>;
  loginOAuth: () => Promise<void>;
  /** Sign `providerId` out, or every provider when left out. */
  logout: (providerId?: string) => Promise<void>;
  /** Reload the account list (after sign-in, sign-out, reordering or enabling). */
  refresh: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  user: null,
  accounts: [],
  loading: true,
  login: async () => {},
  loginOAuth: async () => {},
  logout: async () => {},
  refresh: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

/** The highest-priority enabled, signed-in account's user, else any signed-in one's. */
export function primaryUser(accounts: ProviderAccount[]): User | null {
  const signedIn = accounts.filter((a) => a.authenticated);
  return (signedIn.find((a) => a.enabled) ?? signedIn[0])?.user ?? null;
}

/** Days until `expiration` (rounded up), or null without one. */
export function premiumDaysLeft(user: User | null | undefined): number | null {
  if (!user?.expiration) return null;
  return Math.ceil((new Date(user.expiration).getTime() - Date.now()) / 86400000);
}
