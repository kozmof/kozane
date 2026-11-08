/** Board structure requests: partitions, layers, scopes, and scope frames. */
import type { ScopeArea } from "$lib/types.js";
import type { BoardRect } from "$lib/constants";
import { readFiniteNumber, readString } from "@kozane/client/host";
import { apiUrl, jsonRequest } from "./request.js";

export function createPartition(
  fetcher: typeof fetch,
  namespaceId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/partitions"), "POST", { name });
}

export function deletePartition(
  fetcher: typeof fetch,
  namespaceId: string,
  partitionId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/partitions/${partitionId}`), "DELETE");
}

export function createLayer(
  fetcher: typeof fetch,
  namespaceId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/layers"), "POST", { name });
}

export function deleteLayer(
  fetcher: typeof fetch,
  namespaceId: string,
  layerId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/layers/${layerId}`), "DELETE");
}

export function renameLayer(
  fetcher: typeof fetch,
  namespaceId: string,
  layerId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/layers/${layerId}`), "PATCH", { name });
}

/** `layerIds` is the namespace's full layer ordering, bottom to top. */
export function reorderLayers(
  fetcher: typeof fetch,
  namespaceId: string,
  layerIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/layers"), "PATCH", { layerIds });
}

export function createScope(
  fetcher: typeof fetch,
  namespaceId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/scopes"), "POST", { name });
}

/** Rename a workspace-wide scope. */
export function renameScope(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/scopes/${scopeId}`), "PATCH", { name });
}

export function deleteScope(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/scopes/${scopeId}`), "DELETE");
}

export function addCardsToScope(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/scopes/${scopeId}/members`), "POST", {
    cardIds,
  });
}

export function removeCardsFromScope(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/scopes/${scopeId}/members`), "DELETE", {
    cardIds,
  });
}

/**
 * Create or update a scope frame using its complete canvas rectangle. The server clamps it
 * and returns stored geometry.
 */
export function createScopeArea(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
  rect: BoardRect,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/scopes/${scopeId}/areas`), "POST", rect);
}

/** Move or resize one frame using the complete `rect`. */
export function moveScopeArea(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
  areaId: string,
  rect: BoardRect,
): Promise<Response> {
  return jsonRequest(
    fetcher,
    apiUrl(namespaceId, `/scopes/${scopeId}/areas/${areaId}`),
    "PATCH",
    rect,
  );
}

export function deleteScopeArea(
  fetcher: typeof fetch,
  namespaceId: string,
  scopeId: string,
  areaId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/scopes/${scopeId}/areas/${areaId}`), "DELETE");
}

/**
 * Parse the stored row returned by a scope-area PUT, or return null for an invalid body.
 * Validate the full frame before using its geometry for display or membership.
 */
export function parseScopeArea(value: unknown): ScopeArea | null {
  const id = readString(value, "id");
  const scopeId = readString(value, "scopeId");
  const namespaceId = readString(value, "namespaceId");
  const posX = readFiniteNumber(value, "posX");
  const posY = readFiniteNumber(value, "posY");
  const width = readFiniteNumber(value, "width");
  const height = readFiniteNumber(value, "height");
  if (id === undefined || scopeId === undefined || namespaceId === undefined) return null;
  if (posX === undefined || posY === undefined) return null;
  if (width === undefined || height === undefined) return null;
  return { id, scopeId, namespaceId, posX, posY, width, height };
}
