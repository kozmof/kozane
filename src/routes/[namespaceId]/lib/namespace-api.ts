import { base } from "$app/paths";
import type { CardPositionPatch } from "./namespace-page.js";
import type { Warp } from "$lib/types.js";
import type { WarpListEntry } from "$lib/warp-list.js";
import { readBoolean, readFiniteNumber, readNullableString, readString } from "./response.js";

/**
 * The URL of one namespace-scoped endpoint.
 *
 * Every request here went out as `/${namespaceId}/api/…`, which is right only while `base`
 * is empty. It is empty in every mode that has these endpoints to call — a static export
 * is the one build with a non-empty base, and it is read-only, so the poll and every
 * mutation are switched off before a URL is ever built. That made the missing prefix
 * harmless and invisible in equal measure: the first request added to a path a read-only
 * board still walks would have gone to the wrong origin under `--base`, and nothing here
 * would have said so. One place to be wrong is better than twenty-eight.
 */
function apiUrl(namespaceId: string, path: string): string {
  return `${base}/${namespaceId}/api${path}`;
}

function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return fetcher(url, {
    method,
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

export function patchCardPositions(
  fetcher: typeof fetch,
  namespaceId: string,
  positions: CardPositionPatch[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "PATCH", { positions });
}

export function createCard(
  fetcher: typeof fetch,
  namespaceId: string,
  card: {
    partitionId: string;
    content: string;
    posX: number;
    posY: number;
    zIndex?: number;
    scopeId?: string;
    layerId?: string;
  },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "POST", card);
}

/**
 * The message a failed request explains itself with. SvelteKit's `error()` answers with
 * `{ message }`, and some of those are worth showing verbatim — "the layers changed
 * elsewhere, reload" tells the user what to do in a way a generic banner cannot.
 */
export async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

export function updateCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
  card: {
    content?: string;
    partitionId?: string;
    layerId?: string;
    zIndex?: number;
    /** Null drops the card's own width, putting it back under `ui.defaultCardWidth`. */
    width?: number | null;
  },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/cards/${cardId}`), "PATCH", card);
}

export function deleteCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/cards/${cardId}`), "DELETE");
}

/**
 * Replaces one card with a card per segment of its text. The split pattern is the
 * server's, so nothing about it travels in the request.
 */
export function squashCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/squash"), "POST", { cardId });
}

export function deleteCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "DELETE", { cardIds });
}

export function glueCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/glues"), "POST", { cardIds });
}

export function unglueCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/glues"), "DELETE", { cardIds });
}

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

/** `posX`/`posY` are the world coordinates of the view centre to come back to. */
export function createWarp(
  fetcher: typeof fetch,
  namespaceId: string,
  position: { posX: number; posY: number },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/warps"), "POST", position);
}

/**
 * The row a warp POST answers with, or null when the body is not one. Unlike the other
 * mutations, which read a single field out of their response, a created warp is kept whole
 * and drawn on the board — so an unexpected body would put a marker at `undefined`.
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
 * The rows the warp directory answers with, or null when the body is not a list of them.
 * Checked for the same reason {@link parseWarp} is, and more so: a palette row is rendered
 * whole and then scrolled to, so an unexpected body would list rows reading `undefined`
 * and send the view to `NaN`. All or nothing — a list half of which cannot be trusted is
 * not one to replace a working list with.
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

export function createScope(
  fetcher: typeof fetch,
  namespaceId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/scopes"), "POST", { name });
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

export function batchReassignPartition(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  partitionId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/partition"), "PATCH", {
    cardIds,
    partitionId,
  });
}

export function batchReassignLayer(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  layerId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/layer"), "PATCH", { cardIds, layerId });
}

export function moveCardsToNamespace(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  targetNamespaceId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/move"), "POST", {
    cardIds,
    targetNamespaceId,
  });
}

export function createTaskspace(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspace: { name: string; scopeId: string },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/taskspaces"), "POST", taskspace);
}

/**
 * One directory of a taskspace. `path` is relative to the taskspace root and empty for the
 * root itself; the panel asks again with a deeper path each time a folder is opened.
 */
export function fetchTaskspaceFiles(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return fetcher(apiUrl(namespaceId, `/taskspaces/${taskspaceId}/files${query}`));
}

/**
 * The text of one taskspace file, for the editor. A sibling of {@link fetchTaskspaceFiles}
 * and deliberately a different endpoint: that one answers with names and metadata, and
 * this is the only one that returns what is in a file.
 */
export function fetchTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  const query = `?path=${encodeURIComponent(path)}`;
  return fetcher(apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file${query}`));
}

/**
 * Saves the editor's text back. `signature` is what the file was read at, and the server
 * refuses the write with a 409 if the file has changed since — so a save cannot discard an
 * edit made on disk while the panel had it open.
 */
export function saveTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  file: { path: string; content: string; signature: string | null },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file`), "PUT", file);
}
