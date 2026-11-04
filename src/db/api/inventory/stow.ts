/** Moving cards into and out of inventories, and refitting a card whose text grew. */
import { cardTable, inventoryTable } from "../../schema.js";
import { and, eq, inArray } from "drizzle-orm";
import type { NeedsNamespace, NeedsNamespaceInventory } from "../types.js";
import {
  planRefit,
  planRepair,
  planStow,
  type InventoryPlacement,
  type SlotPlacement,
  type TakenCard,
} from "../../../lib/inventory.js";
import { cardsBelongToNamespace, isStored, writeCardPositionsInTx } from "../card.js";
import { unglueCardsInTx } from "../glue.js";
import { readByIds, type BatchResult } from "../utils.js";
import { withTx, type DB, type Tx } from "../../database.js";
import {
  heldFootprints,
  mergedPlans,
  passesSlotMax,
  releaseCardsInTx,
  settledFootprints,
  sizedCards,
  withSlots,
  writePlacements,
} from "./slots.js";

/** What {@link refitStoredCardInTx} moved. */
export type Refit = {
  /** Where the edited card went, or null when it stayed put or is not stored. */
  moved: InventoryPlacement | null;
  /** Every card whose slot changed, the edited one and any neighbour a repair moved. */
  placements: InventoryPlacement[];
};

/**
 * Refusal for a refit. `inventory-full` means the card's new size fits nowhere before
 * {@link INVENTORY_SLOT_MAX}, as {@link stowCardsInTx} refuses.
 */
export type RefitResult = BatchResult<"inventory-full", Refit>;

/**
 * Move an edited stored card to the first available slot if its new size overlaps another
 * card. Call this inside the transaction that changed the text, and roll it back on a
 * refusal: nothing is written then, so the text change would leave the card overlapping.
 */
export async function refitStoredCardInTx({
  db: tx,
  cardId,
}: {
  db: Tx;
  cardId: string;
}): Promise<RefitResult> {
  const card = await tx
    .select({ inventoryId: cardTable.inventoryId })
    .from(cardTable)
    .where(eq(cardTable.id, cardId))
    .get();
  if (!card?.inventoryId) return { ok: true, moved: null, placements: [] };
  const { inventoryId } = card;
  // Repair the rest first, leaving this card to the refit, so its longer text moves it rather
  // than the neighbour it now covers.
  const held = await heldFootprints(tx, inventoryId);
  const repaired = planRepair(held.filter((f) => f.cardId !== cardId));
  // A repaired neighbour can land on this card's cells, top slot included. The refit then
  // moves this card, and both go in one write, which frees every slot before filling any.
  const [moved]: SlotPlacement[] = planRefit(withSlots(held, repaired), cardId);
  const plan = moved ? [...repaired, moved] : repaired;
  const spans = new Map(held.map(({ cardId: id, span }) => [id, span]));
  if (passesSlotMax(plan, spans)) return { ok: false, reason: "inventory-full" };
  if (plan.length > 0) await writePlacements(tx, inventoryId, plan);
  return {
    ok: true,
    moved: moved ? { ...moved, inventoryId } : null,
    placements: plan.map((p) => ({ ...p, inventoryId })),
  };
}

/**
 * Refusals for a stow. `inventory-full` means the plan would pass {@link INVENTORY_SLOT_MAX}.
 */
export type StowResult = BatchResult<
  "foreign-cards" | "foreign-inventory" | "inventory-full",
  {
    /** Every card whose slot changed, including one a swap displaced. */
    placements: InventoryPlacement[];
    /** Cards left without a glue group, since a card leaves its group to be stored. */
    clearedCardIds: string[];
  }
>;

type StowCards = NeedsNamespaceInventory & {
  cardIds: string[];
  /** The slot the cards were dropped on, or null to fill the first free slots. */
  slot: number | null;
};

/**
 * Store cards from the canvas or another inventory using {@link planStow}.
 * Remove each stored card from its glue group.
 */
export async function stowCards({ db, ...stow }: StowCards & { db: DB }): Promise<StowResult> {
  return withTx(db, (tx) => stowCardsInTx({ db: tx, ...stow }));
}

/**
 * {@link stowCards} inside a caller-owned transaction, for a route that creates a card and
 * stores it in one write.
 */
export async function stowCardsInTx({
  db: tx,
  namespaceId,
  inventoryId,
  cardIds,
  slot,
}: StowCards & { db: Tx }): Promise<StowResult> {
  const unique = [...new Set(cardIds)];
  // Check the destination first, as card batch operations do.
  const inventory = await tx
    .select({ id: inventoryTable.id })
    .from(inventoryTable)
    .where(and(eq(inventoryTable.id, inventoryId), eq(inventoryTable.namespaceId, namespaceId)))
    .get();
  if (!inventory) return { ok: false, reason: "foreign-inventory" };

  const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds: unique });
  if (!owned.ok) return owned;

  const { held, repaired } = await settledFootprints(tx, inventoryId);
  const moving = await sizedCards(tx, unique);
  const plan = planStow(held, moving, slot);
  const spans = new Map([...held, ...moving].map(({ cardId, span }) => [cardId, span]));
  // The repair and the stow go in one write. A card the repair moved and the plan then moved
  // again is named once, where it ended up.
  const final = mergedPlans(repaired, plan);
  // Check the whole write, repairs included, before anything is written, so a refusal leaves
  // the inventory as it was, overlap and all, rather than committing half the work.
  if (passesSlotMax(final, spans)) return { ok: false, reason: "inventory-full" };
  await writePlacements(tx, inventoryId, final);

  const heldIds = new Set(held.map(({ cardId }) => cardId));
  const clearedCardIds = await unglueCardsInTx({
    db: tx,
    cardIds: plan.map(({ cardId }) => cardId).filter((id) => !heldIds.has(id)),
  });
  return {
    ok: true,
    placements: final.map((p) => ({ ...p, inventoryId })),
    clearedCardIds,
  };
}

/** Refusals for a take. `unstored-cards` means a named card is not in any inventory. */
export type TakeResult = BatchResult<"foreign-cards" | "unstored-cards">;

/**
 * Return stored cards to the supplied positions or their previous canvas positions.
 * Reject cards already on the canvas because this path bypasses grid snapping and glue-group
 * movement.
 */
export async function takeCards({
  db,
  namespaceId,
  cards,
}: NeedsNamespace & { db: DB; cards: TakenCard[] }): Promise<TakeResult> {
  if (cards.length === 0) return { ok: true };
  // Last entry wins for a repeated card, as position updates do.
  const unique = [...new Map(cards.map((card) => [card.cardId, card])).values()];
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({
      db: tx,
      namespaceId,
      cardIds: unique.map(({ cardId }) => cardId),
    });
    if (!owned.ok) return owned;
    const cardIds = unique.map(({ cardId }) => cardId);
    const stored = await readByIds(cardIds, (batch) =>
      tx
        .select({ id: cardTable.id })
        .from(cardTable)
        .where(and(inArray(cardTable.id, batch), isStored)),
    );
    if (stored.length !== cardIds.length) return { ok: false, reason: "unstored-cards" };
    await releaseCardsInTx({ db: tx, cardIds });
    await writeCardPositionsInTx({
      db: tx,
      positions: unique.flatMap(({ cardId, position }) =>
        position ? [{ cardId, ...position }] : [],
      ),
    });
    return { ok: true };
  });
}
