import { call } from "./transport";
import type { DeviceCode, DeviceCredentials, OAuthToken, User } from "../types";

/** Sign provider `providerId` in with `token` (the primary provider when left out). */
export async function setApiToken(token: string, providerId?: string): Promise<void> {
  return call("set_api_token", { token, providerId: providerId ?? null });
}

export async function loadSavedToken(): Promise<boolean> {
  return call("load_saved_token");
}

/** Sign provider `providerId` out, or every provider when left out. */
export async function logout(providerId?: string): Promise<void> {
  return call("logout", { providerId: providerId ?? null });
}

export async function isAuthenticated(): Promise<boolean> {
  return call("is_authenticated");
}

export async function getUser(providerId?: string): Promise<User> {
  return call("get_user", { providerId: providerId ?? null });
}

export async function oauthStart(): Promise<DeviceCode> {
  return call("oauth_start");
}

export async function oauthPollCredentials(
  deviceCode: string
): Promise<DeviceCredentials | null> {
  return call("oauth_poll_credentials", { deviceCode });
}

export async function oauthGetToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string
): Promise<OAuthToken> {
  return call("oauth_get_token", { clientId, clientSecret, deviceCode });
}
