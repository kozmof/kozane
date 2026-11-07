/** Where a card sits: on the canvas, or in one inventory slot. Both columns move together. */

import { and, isNotNull, isNull, or } from "drizzle-orm";
import { cardTable } from "../../schema.js";
import type { CardData } from "../../types.js";

/**
 * The two inventory columns for a card's place: both set for a stored card, both null for one
 * on the canvas. Writers build the columns through this, so they cannot set one without the
 * other. {@link cardInventory} is the reverse.
 */
export function inventoryColumns(placement: CardData["inventory"]): {
  inventoryId: string | null;
  inventorySlot: number | null;
} {
  return placement === null
    ? { inventoryId: null, inventorySlot: null }
    : { inventoryId: placement.id, inventorySlot: placement.slot };
}

/**
 * A stored card's inventory and slot. Writers set and clear the two columns together through
 * {@link inventoryColumns}, and a row with only one of them reads as a card on the canvas.
 */
export function cardInventory(
  inventoryId: string | null,
  slot: number | null,
): CardData["inventory"] {
  return inventoryId === null || slot === null ? null : { id: inventoryId, slot };
}

/** Card row with both inventory columns combined into the board's `inventory` field. */
export function withCardInventory<
  T extends { inventoryId: string | null; inventorySlot: number | null },
>({
  inventoryId,
  inventorySlot,
  ...card
}: T): Omit<T, "inventoryId" | "inventorySlot"> & Pick<CardData, "inventory"> {
  return { ...card, inventory: cardInventory(inventoryId, inventorySlot) };
}

/**
 * Cards stored in an inventory: both inventory columns set, the same test
 * {@link cardInventory} uses, so SQL reads and the board agree on where a card is.
 */
export const isStored = and(isNotNull(cardTable.inventoryId), isNotNull(cardTable.inventorySlot))!;

/**
 * Cards on the canvas, leaving out stored ones. The opposite of {@link isStored}. A stored
 * card keeps the position it goes back to, so any read that treats positions as space taken
 * up on the board filters with this.
 */
export const onCanvas = or(isNull(cardTable.inventoryId), isNull(cardTable.inventorySlot))!;

/**
 * Cards with only one of the two inventory columns set. No writer leaves this, but raw SQL can.
 * Such a card counts as on the canvas everywhere ({@link onCanvas}, {@link cardInventory}).
 * `kozane doctor` reports it and `kozane inventory repair` clears both columns.
 */
export const halfPlaced = or(
  and(isNotNull(cardTable.inventoryId), isNull(cardTable.inventorySlot)),
  and(isNull(cardTable.inventoryId), isNotNull(cardTable.inventorySlot)),
)!;
