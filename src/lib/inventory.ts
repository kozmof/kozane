import { INVENTORY_COLUMNS, INVENTORY_MIN_ROWS } from "./constants.js";

/**
 * Slot planning and grid layout for inventories. The server plans with what it reads inside
 * its transaction and the board plans with what it holds, so the same function decides both.
 * The board's guess is then the server's answer unless another writer got there first.
 */

/** Where one card goes. */
export type SlotPlacement = { cardId: string; slot: number };

/** Where one card goes, with the inventory it goes into, as a stow answers. */
export type InventoryPlacement = SlotPlacement & { inventoryId: string };

/** The lowest slot at or after `from` that nothing has taken. */
function firstFree(taken: ReadonlySet<number>, from: number): number {
  let slot = from;
  while (taken.has(slot)) slot++;
  return slot;
}

/**
 * Plan where cards land when they are put into one inventory.
 *
 * `occupants` is what the inventory holds now, by slot. `target` is the slot they were
 * dropped on, or null to fill from the start.
 *
 * - One card dropped on a slot takes that slot. A card already there swaps with it when the
 *   moving card came from this inventory, or moves to the first free slot otherwise.
 * - Anything else fills free slots in order, from `target` onward, skipping taken ones.
 *   Cards already in this inventory stay where they are.
 *
 * Returns only the cards whose slot changes, the displaced occupant included.
 */
export function planStow(
  occupants: ReadonlyMap<number, string>,
  cardIds: readonly string[],
  target: number | null,
): SlotPlacement[] {
  const unique = [...new Set(cardIds)];
  const slotOf = new Map([...occupants].map(([slot, cardId]) => [cardId, slot]));

  if (target !== null && unique.length === 1) {
    const [cardId] = unique;
    const from = slotOf.get(cardId);
    if (from === target) return [];
    const plan = [{ cardId, slot: target }];
    const occupant = occupants.get(target);
    if (occupant === undefined) return plan;
    const taken = new Set([...occupants.keys(), target]);
    plan.push({ cardId: occupant, slot: from ?? firstFree(taken, 0) });
    return plan;
  }

  const taken = new Set(occupants.keys());
  const plan: SlotPlacement[] = [];
  let next = target ?? 0;
  for (const cardId of unique) {
    if (slotOf.has(cardId)) continue;
    next = firstFree(taken, next);
    taken.add(next);
    plan.push({ cardId, slot: next });
  }
  return plan;
}

/** The slots of one inventory's cards, keyed by slot. */
export function inventoryOccupants(
  cards: readonly { id: string; inventoryId: string | null; inventorySlot: number | null }[],
  inventoryId: string,
): Map<number, string> {
  const occupants = new Map<number, string>();
  for (const card of cards) {
    if (card.inventoryId === inventoryId && card.inventorySlot !== null)
      occupants.set(card.inventorySlot, card.id);
  }
  return occupants;
}

/** Row and column of a slot, both counted from zero. */
export function slotCell(
  slot: number,
  columns = INVENTORY_COLUMNS,
): { row: number; column: number } {
  return { row: Math.floor(slot / columns), column: slot % columns };
}

/**
 * How many rows to draw. Always one empty row below the last card, so a full grid still has
 * somewhere to drop into, and never fewer than {@link INVENTORY_MIN_ROWS}.
 */
export function inventoryRows(
  slots: Iterable<number>,
  columns = INVENTORY_COLUMNS,
  minRows = INVENTORY_MIN_ROWS,
): number {
  let last = -1;
  for (const slot of slots) last = Math.max(last, slot);
  return Math.max(minRows, Math.floor(last / columns) + 2);
}
