import { call } from "./transport";
import type { ProviderStats } from "../types";

/** Every provider's add hits and misses, in priority order. */
export async function getProviderStats(): Promise<ProviderStats[]> {
  return call("get_provider_stats");
}

/** Zero every provider's counts. */
export async function resetProviderStats(): Promise<void> {
  return call("reset_provider_stats");
}
