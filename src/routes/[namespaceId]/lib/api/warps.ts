/** Warp requests, and the directory of every namespace's warps. */
import type { Warp } from "$lib/types.js";
import type { WarpListEntry } from "$lib/warp-list.js";
import { readBoolean, readFiniteNumber, readNullableString, readString } from "../response.js";
import { apiUrl, jsonRequest } from "./request.js";

/** `posX`/`posY` are the world coordinates of the view centre to come back to. */
export function createWarp(
  fetcher: typeof fetch,
  namespaceId: string,
  position: { posX: number; posY: number },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/warps"), "POST", position);
}

/**
 * Validate the created warp row before placing it on the board. Return null for an invalid
 * response.
 */
export function parseWarp(value: unknown): Warp | null {
  const id = readString(value, "id");
  const namespaceId = readString(value, "namespaceId");
  const posX = readFiniteNumber(value, "posX");
  const posY = readFiniteNumber(value, "posY");
  if (id === undefined || namespaceId === undefined) return null;
  if (posX === undefined || posY === undefined) return null;
  return { id, namespaceId, posX, posY };
}

/** Moves an existing warp. `posX`/`posY` are where it is being dropped. */
export function moveWarp(
  fetcher: typeof fetch,
  namespaceId: string,
  warpId: string,
  position: { posX: number; posY: number },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/warps/${warpId}`), "PATCH", position);
}

export function deleteWarp(
  fetcher: typeof fetch,
  namespaceId: string,
  warpId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/warps/${warpId}`), "DELETE");
}

/** The other namespaces' warps, as the palette lists them. */
export function fetchWarpDirectory(fetcher: typeof fetch, namespaceId: string): Promise<Response> {
  return fetcher(apiUrl(namespaceId, "/warp-directory"));
}

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
