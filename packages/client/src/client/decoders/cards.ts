import type {
  CardCreateResult,
  CardUpdateResult,
  CardSetStackingResult,
  CardSquashResult,
  GlueCreateResult,
  GlueRemoveResult,
} from "../resources.js";
import { readCard, readCardInventory } from "./snapshot-reader.js";
import { readInventoryResult } from "./inventories.js";
import { readMutationOk } from "./structure.js";
import {
  readStackingRows,
  readUniqueIds,
  readValidPlacements,
  validInventorySlot,
} from "./collections.js";
import { readArray, readObject, readString, readText } from "./response.js";

function mutationCard(value: unknown) {
  const card = readCard(value);
  return card && (!card.inventory || validInventorySlot(card.inventory.slot)) ? card : null;
}
export function readCardCreated(value: unknown, input: unknown): CardCreateResult | null {
  const card = mutationCard(value);
  const placements = readValidPlacements(value);
  if (
    !card ||
    !placements ||
    card.taskspaceId !== null ||
    card.glueId !== null ||
    card.width !== null ||
    card.partitionId !== readString(input, "partitionId")
  )
    return null;
  const layerId = readString(input, "layerId");
  if (layerId !== undefined && card.layerId !== layerId) return null;
  const inventoryId = readString(input, "inventoryId");
  if (inventoryId === undefined) {
    if (card.inventory !== null || placements.length !== 0) return null;
  } else {
    if (
      card.inventory?.id !== inventoryId ||
      placements.some((p) => p.inventoryId !== inventoryId) ||
      !placements.some((p) => p.cardId === card.id && p.slot === card.inventory!.slot)
    )
      return null;
  }
  return { ...card, taskspaceId: null, glueId: null, width: null, placements };
}
export function readCardStacked(value: unknown): CardSetStackingResult | null {
  const stacking = readStackingRows(value);
  return readMutationOk(value) && stacking ? { ok: true, stacking } : null;
}
export function readCardUpdated(
  value: unknown,
  cardId: string,
  input: unknown,
): CardUpdateResult | null {
  const stacked = readCardStacked(value);
  if (!stacked) return null;
  const record = value as Record<string, unknown>;
  const content = readText(value, "content");
  if (
    (record.content !== undefined || readText(input, "content") !== undefined) &&
    content === undefined
  )
    return null;
  const inventory = record.inventory === undefined ? undefined : readCardInventory(value);
  if (record.inventory !== undefined && (!inventory || !validInventorySlot(inventory.slot)))
    return null;
  const placements = record.placements === undefined ? undefined : readValidPlacements(value);
  if (placements === null) return null;
  if (
    inventory &&
    (!placements ||
      !placements.some(
        (p) => p.cardId === cardId && p.inventoryId === inventory.id && p.slot === inventory.slot,
      ))
  )
    return null;
  return {
    ...stacked,
    ...(content === undefined ? {} : { content }),
    ...(inventory ? { inventory } : {}),
    ...(placements === undefined ? {} : { placements }),
  };
}
function timestamp(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return typeof value === "string" && date.toISOString() !== value ? null : date;
}
export function readCardSquashed(value: unknown, namespaceId: string): CardSquashResult | null {
  const inventory = readInventoryResult(readObject(value, "inventory"), namespaceId);
  const rows = readArray(value, "cards");
  const stacking = readStackingRows(value);
  if (!inventory || !rows || rows.length < 2 || !stacking) return null;
  const cards: CardSquashResult["cards"] = [];
  const ids = new Set<string>();
  const slots = new Set<number>();
  for (const row of rows) {
    const card = mutationCard(row);
    if (
      !card ||
      card.glueId !== null ||
      card.inventory?.id !== inventory.id ||
      ids.has(card.id) ||
      slots.has(card.inventory.slot)
    )
      return null;
    ids.add(card.id);
    slots.add(card.inventory.slot);
    const record = row as Record<string, unknown>;
    const createdAt = timestamp(record.createdAt);
    const updatedAt = timestamp(record.updatedAt);
    if (!createdAt || !updatedAt) return null;
    cards.push({ ...card, glueId: null, createdAt, updatedAt });
  }
  return { inventory, cards, stacking };
}
export function readGlueCreated(value: unknown): GlueCreateResult | null {
  const glueId = readString(value, "glueId");
  const clearedCardIds = readUniqueIds(value, "clearedCardIds");
  return glueId && clearedCardIds ? { glueId, clearedCardIds } : null;
}
export function readGlueRemoved(value: unknown): GlueRemoveResult | null {
  const clearedCardIds = readUniqueIds(value, "clearedCardIds");
  return readMutationOk(value) && clearedCardIds ? { ok: true, clearedCardIds } : null;
}
