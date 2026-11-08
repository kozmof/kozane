import { INVENTORY_SLOT_MAX } from "../../constants/index.js";
import type { CardSetStackingResult } from "../resources.js";
import { readPlacements } from "./placements.js";
import { readArray, readFiniteNumber, readString, readStringArray } from "./response.js";

export function readUniqueIds(value: unknown, key: string): string[] | null {
  const ids = readStringArray(value, key);
  return ids && new Set(ids).size === ids.length ? [...ids] : null;
}
export function readStackingRows(value: unknown): CardSetStackingResult["stacking"] | null {
  const rows = readArray(value, "stacking");
  if (!rows) return null;
  const stacking: CardSetStackingResult["stacking"] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const cardId = readString(row, "cardId");
    const zIndex = readFiniteNumber(row, "zIndex");
    if (!cardId || zIndex === undefined || ids.has(cardId)) return null;
    ids.add(cardId);
    stacking.push({ cardId, zIndex });
  }
  return stacking;
}
export function validInventorySlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot <= INVENTORY_SLOT_MAX;
}
export function readValidPlacements(value: unknown) {
  const placements = readPlacements(value);
  if (!placements) return null;
  const ids = new Set<string>();
  const slots = new Map<string, Set<number>>();
  for (const row of placements) {
    const occupied = slots.get(row.inventoryId) ?? new Set<number>();
    if (!validInventorySlot(row.slot) || ids.has(row.cardId) || occupied.has(row.slot)) return null;
    ids.add(row.cardId);
    occupied.add(row.slot);
    slots.set(row.inventoryId, occupied);
  }
  return placements;
}
