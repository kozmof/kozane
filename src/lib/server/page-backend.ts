import type { BackendCapabilities } from "../backend/contract.js";
import type { StaticBackendData } from "../backend/static-backend.js";
import { httpBackendCapabilities } from "./backend-capabilities.js";
/** Optional fields retain compatibility with page data from older exports. */
export interface PageBackendData {
  backendCapabilities?: BackendCapabilities;
  backendLifetimeNotice?: string;
  staticBackendData?: StaticBackendData;
}
/** Select transport metadata only after loaders apply their export privacy gates. */
export function pageBackendData(prerender: boolean, embedded: StaticBackendData): PageBackendData {
  if (prerender) return { staticBackendData: embedded };
  const backendCapabilities = httpBackendCapabilities();
  return {
    backendCapabilities,
    ...(!backendCapabilities.persistent
      ? {
          backendLifetimeNotice:
            "Database changes last for this server process and are lost when it stops.",
        }
      : {}),
  };
}
