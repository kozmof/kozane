import type { BackendCapabilities } from "../backend/contract.js";
import { getDBURL, getWorkspaceRoot } from "../../db/internal/config.js";
import { isMemoryDbUrl } from "../db-url.js";
import { readApiKeyResult } from "./api-key.js";
/** Resolve before SSR so hydration uses the same editing and lifetime policy. */
export function httpBackendCapabilities(): BackendCapabilities {
  const root = getWorkspaceRoot();
  const auth = root ? readApiKeyResult(root) : null;
  return Object.freeze({
    writable: process.env.KOZANE_READONLY !== "1",
    persistent: process.env.KOZANE_MEMORY_MODE !== "1" && !isMemoryDbUrl(getDBURL()),
    taskspaces: true,
    externalWrites: true,
    auth: auth?.ok === true && auth.key !== null,
  });
}
