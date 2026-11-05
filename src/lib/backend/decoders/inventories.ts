import { INVENTORY_SLOT_MAX } from "../../constants.js";
import type {
  InventoryCreateResult,
  InventoryRemoveResult,
  InventoryStowResult,
  InventoryTakeResult,
} from "../resources.js";
import { readInventory } from "./snapshot-reader.js";
import { readPlacements } from "./placements.js";
import { readArray, readFiniteNumber, readString, readStringArray } from "./response.js";

export function readInventoryResult(
  value: unknown,
  namespaceId: string,
  inventoryId?: string,
): InventoryCreateResult | null {
  const inventory = readInventory(value);
  return inventory &&
    inventory.namespaceId === namespaceId &&
    (inventoryId === undefined || inventory.id === inventoryId)
    ? inventory
    : null;
}
function uniqueIds(value: unknown, key: string): string[] | null {
  const ids = readStringArray(value, key);
  return ids && new Set(ids).size === ids.length ? [...ids] : null;
}
export function readInventoryRemoved(value: unknown): InventoryRemoveResult | null {
  const releasedCardIds = uniqueIds(value, "releasedCardIds");
  return releasedCardIds ? { releasedCardIds } : null;
}
export function readInventoryStowed(
  value: unknown,
  inventoryId: string,
): InventoryStowResult | null {
  const placements = readPlacements(value);
  const clearedCardIds = uniqueIds(value, "clearedCardIds");
  if (!placements || !clearedCardIds) return null;
  const ids = new Set<string>();
  const slots = new Set<number>();
  for (const row of placements) {
    if (
      row.inventoryId !== inventoryId ||
      !Number.isInteger(row.slot) ||
      row.slot < 0 ||
      row.slot > INVENTORY_SLOT_MAX ||
      ids.has(row.cardId) ||
      slots.has(row.slot)
    )
      return null;
    ids.add(row.cardId);
    slots.add(row.slot);
  }
  return { placements, clearedCardIds };
}
export function readInventoryTaken(value: unknown, input: unknown): InventoryTakeResult | null {
  const rows = readArray(value, "cards");
  const request = readArray(input, "cards");
  if (!rows || !request) return null;
  const requested = new Map<string, boolean>();
  for (const row of request) {
    const id = readString(row, "cardId");
    if (!id || requested.has(id)) return null;
    const record = row as Record<string, unknown>;
    requested.set(id, record.posX !== undefined || record.posY !== undefined);
  }
  if (rows.length !== requested.size) return null;
  const cards: InventoryTakeResult["cards"] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const cardId = readString(row, "cardId");
    if (!cardId || !requested.has(cardId) || ids.has(cardId)) return null;
    const record = row as Record<string, unknown>;
    const hasPosition = record.posX !== undefined || record.posY !== undefined;
    const posX = readFiniteNumber(row, "posX");
    const posY = readFiniteNumber(row, "posY");
    if ((hasPosition || requested.get(cardId)) && (posX === undefined || posY === undefined))
      return null;
    ids.add(cardId);
    cards.push(posX === undefined || posY === undefined ? { cardId } : { cardId, posX, posY });
  }
  return { cards };
}
