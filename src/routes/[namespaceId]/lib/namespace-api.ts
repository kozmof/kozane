import { base } from "$app/paths";
import { byteLength } from "$lib/byte-length.js";
import type { CardPositionPatch } from "./namespace-page.js";
import type { CardWithGlue, Inventory, ScopeArea, Warp } from "$lib/types.js";
import type { InventoryPlacement, TakenCard } from "$lib/inventory.js";
import type { BoardPoint } from "./canvas-viewport.js";
import type { WarpListEntry } from "$lib/warp-list.js";
import type { BoardRect } from "$lib/constants";
import {
  readArray,
  readBoolean,
  readFiniteNumber,
  readNullableString,
  readString,
} from "./response.js";
import { readCard, readInventory } from "./snapshot-reader.js";

/** Build a namespace endpoint URL with the configured base path. */
function apiUrl(namespaceId: string, path: string): string {
  return `${base}/${namespaceId}/api${path}`;
}

function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  method: string,
  body?: unknown,
  { keepalive = false }: SaveOptions = {},
): Promise<Response> {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return fetcher(url, {
    method,
    ...(json !== undefined && { headers: { "Content-Type": "application/json" }, body: json }),
    // Browsers refuse a keepalive request over their body quota, so send a larger one as usual.
    ...(keepalive && json !== undefined && fitsKeepalive(json) && { keepalive: true }),
  });
}

/** Options for a request that may be sent as the page goes away. */
export type SaveOptions = {
  /** Let the request outlive the page, for a save sent as the tab closes. Small bodies only. */
  keepalive?: boolean;
};

/** Kept under the 64 KiB that browsers allow keepalive request bodies in flight. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

/**
 * Whether `json` is within {@link KEEPALIVE_MAX_BYTES}. A UTF-16 code unit is one to three
 * UTF-8 bytes, so most bodies are decided by length alone without encoding them.
 */
function fitsKeepalive(json: string): boolean {
  if (json.length > KEEPALIVE_MAX_BYTES) return false;
  if (json.length * 3 <= KEEPALIVE_MAX_BYTES) return true;
  return byteLength(json) <= KEEPALIVE_MAX_BYTES;
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
    /** Stores the new card in this inventory's first free slot instead of on the canvas. */
    inventoryId?: string;
  },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards"), "POST", card);
}

/** Read the server's failure message so callers can show specific recovery guidance. */
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
    /** Null clears the pinned width and restores `ui.defaultCardWidth`. */
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
 * Replace one card with a card per text segment. The server chooses the split pattern.
 * The request sends no split options.
 */
export function squashCard(
  fetcher: typeof fetch,
  namespaceId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/squash"), "POST", { cardId });
}

/**
 * Validate a created card through {@link readCard}, returning null for an invalid response.
 * Use the stored row so clamped coordinates reach the board.
 */
export function parseCard(value: unknown): CardWithGlue | null {
  return readCard(value) ?? null;
}

/**
 * Validate every card in a nonempty squash response. Reject the whole result if any element
 * is invalid because partial replacement would lose part of the source card.
 */
export function parseCards(value: unknown): CardWithGlue[] | null {
  const rows = readArray(value, "cards");
  if (!rows || rows.length === 0) return null;
  const cards: CardWithGlue[] = [];
  for (const row of rows) {
    const card = readCard(row);
    if (!card) return null;
    cards.push(card);
  }
  return cards;
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

export function batchChangeStackOrder(
  fetcher: typeof fetch,
  namespaceId: string,
  cardIds: string[],
  direction: "front" | "back",
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/cards/stacking"), "PATCH", {
    cardIds,
    direction,
  });
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

/** Read one taskspace directory by relative path. An empty path names the root. */
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
 * Create an empty file and return its readable state. Existing names return 409. Write
 * content through {@link saveTaskspaceFile}.
 */
export function createTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file`), "POST", {
    path,
  });
}

/**
 * Create a taskspace directory through the `files` route and return its empty listing.
 * Return `404` if the parent is missing or `409` if the name is already taken.
 */
export function createTaskspaceFolder(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  path: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/taskspaces/${taskspaceId}/files`), "POST", {
    path,
  });
}

/**
 * Fetch taskspace file text for the editor. {@link fetchTaskspaceFiles} uses a separate
 * endpoint for names and metadata.
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
 * Save text with the signature from the last read. The server returns 409 if the file changed
 * in the meantime. `keepalive` lets a small save outlive the page, as when the tab closes.
 */
export function saveTaskspaceFile(
  fetcher: typeof fetch,
  namespaceId: string,
  taskspaceId: string,
  file: { path: string; content: string; signature: string | null },
  options: SaveOptions = {},
): Promise<Response> {
  return jsonRequest(
    fetcher,
    apiUrl(namespaceId, `/taskspaces/${taskspaceId}/file`),
    "PUT",
    file,
    options,
  );
}

export function createInventory(
  fetcher: typeof fetch,
  namespaceId: string,
  position: BoardPoint,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/inventories"), "POST", position);
}

/** Moves an inventory's icon, renames it, or both. */
export function updateInventory(
  fetcher: typeof fetch,
  namespaceId: string,
  inventoryId: string,
  fields: { posX?: number; posY?: number; name?: string },
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/inventories/${inventoryId}`), "PATCH", fields);
}

export function deleteInventory(
  fetcher: typeof fetch,
  namespaceId: string,
  inventoryId: string,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/inventories/${inventoryId}`), "DELETE");
}

/** Puts cards into an inventory, on `slot` or in the first free slots when it is null. */
export function stowCards(
  fetcher: typeof fetch,
  namespaceId: string,
  inventoryId: string,
  cardIds: string[],
  slot: number | null,
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, `/inventories/${inventoryId}/cards`), "POST", {
    cardIds,
    ...(slot !== null && { slot }),
  });
}

/** Puts stored cards back on the canvas. A card without a position returns to its old one. */
export function takeCards(
  fetcher: typeof fetch,
  namespaceId: string,
  cards: TakenCard[],
): Promise<Response> {
  return jsonRequest(fetcher, apiUrl(namespaceId, "/inventories/take"), "POST", { cards });
}

/** Validate a stored inventory row, returning null for an invalid response. */
export function parseInventory(value: unknown): Inventory | null {
  return readInventory(value) ?? null;
}

/** The slots a stow assigned, or null if any entry is malformed. */
export function parsePlacements(value: unknown): InventoryPlacement[] | null {
  const rows = readArray(value, "placements");
  if (!rows) return null;
  const placements: InventoryPlacement[] = [];
  for (const row of rows) {
    const cardId = readString(row, "cardId");
    const inventoryId = readString(row, "inventoryId");
    const slot = readFiniteNumber(row, "slot");
    if (cardId === undefined || inventoryId === undefined || slot === undefined) return null;
    placements.push({ cardId, inventoryId, slot });
  }
  return placements;
}
