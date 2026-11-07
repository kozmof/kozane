/** Warp requests, and the directory of every namespace's warps. */
import type { Warp } from "$lib/types.js";
import {
  readFiniteNumber,
  readString,
} from "../../../../../packages/client/src/board/lib/response.js";
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

export { parseWarpEntries } from "$lib/backend/decoders/warp-directory.js";
