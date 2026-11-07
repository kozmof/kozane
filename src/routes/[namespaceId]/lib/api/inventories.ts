/** Inventory requests: create, rename, delete, stow, and take. */
import type { Inventory } from "$lib/types.js";
import type { InventoryPlacement, TakenCard } from "$lib/inventory.js";
import type { BoardPoint } from "../../../../../packages/client/src/board/lib/canvas-viewport.js";
import {
  readArray,
  readFiniteNumber,
  readString,
} from "../../../../../packages/client/src/board/lib/response.js";
import { readInventory } from "../snapshot-reader.js";
import { apiUrl, jsonRequest } from "./request.js";

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
