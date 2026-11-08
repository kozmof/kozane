import type { InventoryPlacement } from "@kozane/core";
import { readArray, readString, readFiniteNumber } from "./response.js";
export function readPlacements(value: unknown): InventoryPlacement[] | undefined {
  const rows = readArray(value, "placements");
  if (!rows) return undefined;
  const result: InventoryPlacement[] = [];
  for (const row of rows) {
    const cardId = readString(row, "cardId"),
      inventoryId = readString(row, "inventoryId"),
      slot = readFiniteNumber(row, "slot");
    if (cardId === undefined || inventoryId === undefined || slot === undefined) return undefined;
    result.push({ cardId, inventoryId, slot });
  }
  return result;
}
