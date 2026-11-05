import type { BackendCapabilities } from "../backend/contract.js";
import type { StaticBackendData } from "../backend/static-backend.js";
import { httpBackendCapabilities } from "./backend-capabilities.js";
/** Optional fields retain compatibility with page data from older exports. */
export interface PageBackendData {
  backendCapabilities?: BackendCapabilities;
  staticBackendData?: StaticBackendData;
}
/** Select transport metadata only after loaders apply their export privacy gates. */
export function pageBackendData(prerender: boolean, embedded: StaticBackendData): PageBackendData {
  return prerender
    ? { staticBackendData: embedded }
    : { backendCapabilities: httpBackendCapabilities() };
}
