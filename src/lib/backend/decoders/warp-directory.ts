import type { WarpListEntry } from "$lib/warp-list.js";
import { readBoolean, readFiniteNumber, readNullableString, readString } from "./response.js";

/**
 * Validate the complete warp directory before replacing the current list. Reject partial or
 * malformed results.
 */
export function parseWarpEntries(value: unknown): WarpListEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: WarpListEntry[] = [];
  for (const row of value) {
    const id = readString(row, "id");
    const namespaceId = readString(row, "namespaceId");
    const namespaceName = readString(row, "namespaceName");
    const isCurrent = readBoolean(row, "isCurrent");
    const label = readFiniteNumber(row, "label");
    const posX = readFiniteNumber(row, "posX");
    const posY = readFiniteNumber(row, "posY");
    const hint = readNullableString(row, "hint");
    if (id === undefined || namespaceId === undefined || namespaceName === undefined) return null;
    if (isCurrent === undefined || hint === undefined) return null;
    if (label === undefined || posX === undefined || posY === undefined) return null;
    entries.push({ id, namespaceId, namespaceName, label, posX, posY, hint, isCurrent });
  }
  return entries;
}
