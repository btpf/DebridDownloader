import { call } from "./transport";
import type { ProviderAccount, ProviderInfo } from "../types";

export async function getAvailableProviders(): Promise<ProviderInfo[]> {
  return call("get_available_providers");
}

export async function switchProvider(providerId: string): Promise<boolean> {
  return call("switch_provider", { providerId });
}

export async function getActiveProvider(): Promise<string> {
  return call("get_active_provider");
}

export async function getAuthMethod(providerId?: string): Promise<"api_key" | "oauth_device"> {
  return call("get_auth_method", { providerId: providerId ?? null });
}

/** Every provider in priority order: enabled or not, signed in or not, and its account. */
export async function getProviderAccounts(): Promise<ProviderAccount[]> {
  return call("get_provider_accounts");
}
