import type { ClientCapabilities } from "@kozane/client";
import type { StaticClientData } from "@kozane/client";
import { httpClientCapabilities } from "./client-capabilities.js";
/** Optional fields retain compatibility with page data from older exports. */
export interface PageClientData {
  clientCapabilities?: ClientCapabilities;
  clientLifetimeNotice?: string;
  staticClientData?: StaticClientData;
}
/** Select transport metadata only after loaders apply their export privacy gates. */
export function pageClientData(prerender: boolean, embedded: StaticClientData): PageClientData {
  if (prerender) return { staticClientData: embedded };
  const clientCapabilities = httpClientCapabilities();
  return {
    clientCapabilities,
    ...(!clientCapabilities.persistent
      ? {
          clientLifetimeNotice:
            "Database changes last for this server process and are lost when it stops.",
        }
      : {}),
  };
}
