import { cardTable, inventoryTable } from "../schema.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  Inventory,
  NeedsInventory,
  NeedsNamespace,
  NeedsNamespaceInventory,
} from "./types.js";
import { BATCH_MAX, INVENTORY_SLOT_MAX, chunked } from "../../lib/constants.js";
import { planStow, type InventoryPlacement } from "../../lib/inventory.js";
import { cardsBelongToNamespace } from "./card.js";
import { unglueCardsInTx } from "./glue.js";
import {
  assertFound,
  assertNameWithinLimit,
  type BatchResult,
  type CardBatchResult,
} from "./utils.js";
import { withTx, type DB, type Tx } from "../tx.js";

/** A namespace's inventories in creation order. */
export async function getAllInventories({ db, namespaceId }: NeedsNamespace): Promise<Inventory[]> {
  return db
    .select()
    .from(inventoryTable)
    .where(eq(inventoryTable.namespaceId, namespaceId))
    .orderBy(asc(inventoryTable.id));
}

export type StoredCard = { id: string; content: string; slot: number };

/** The cards one inventory holds, in slot order. */
export async function getInventoryCards({
  db,
  inventoryId,
}: NeedsInventory): Promise<StoredCard[]> {
  const rows = await db
    .select({ id: cardTable.id, content: cardTable.content, slot: cardTable.inventorySlot })
    .from(cardTable)
    .where(eq(cardTable.inventoryId, inventoryId))
    .orderBy(asc(cardTable.inventorySlot));
  return rows.flatMap(({ slot, ...card }) => (slot === null ? [] : [{ ...card, slot }]));
}

type AddInventory = NeedsNamespace & { name?: string; posX: number; posY: number };

export async function addInventory({
  db,
  namespaceId,
  name = "",
  posX,
  posY,
}: AddInventory): Promise<Inventory> {
  assertNameWithinLimit(name, "Inventory name");
  const [row] = await db
    .insert(inventoryTable)
    .values({ namespaceId, name, posX, posY })
    .returning();
  return row;
}

type UpdateInventory = NeedsNamespaceInventory & { name?: string; posX?: number; posY?: number };

/**
 * Moves or renames an inventory. The whole stored row comes back, so a caller that drew the
 * icon where the pointer let go can correct it to what was kept.
 */
export async function updateInventory({
  db,
  namespaceId,
  inventoryId,
  name,
  posX,
  posY,
}: UpdateInventory): Promise<Inventory> {
  if (name !== undefined) assertNameWithinLimit(name, "Inventory name");
  const fields = {
    ...(name !== undefined && { name }),
    ...(posX !== undefined && { posX }),
    ...(posY !== undefined && { posY }),
  };
  if (Object.keys(fields).length === 0) throw new Error("updateInventory: no fields to update");
  // Check namespace ownership even though the ID is unique.
  const updated = await db
    .update(inventoryTable)
    .set(fields)
    .where(and(eq(inventoryTable.namespaceId, namespaceId), eq(inventoryTable.id, inventoryId)))
    .returning();
  assertFound(updated, `Inventory namespaceId=${namespaceId} inventoryId=${inventoryId}`);
  return updated[0];
}

/** Takes cards out of whatever inventory holds them. Their canvas positions are kept. */
async function releaseCards(tx: Tx, cardIds: string[]): Promise<void> {
  for (const batch of chunked(cardIds, { size: BATCH_MAX }))
    await tx
      .update(cardTable)
      .set({ inventoryId: null, inventorySlot: null })
      .where(inArray(cardTable.id, batch));
}

/**
 * Deletes an inventory. Its cards go back on the canvas where they were before they were
 * stored, and their IDs come back so a caller can draw them there.
 */
export async function deleteInventory({
  db,
  namespaceId,
  inventoryId,
}: NeedsNamespaceInventory & { db: DB }): Promise<{ releasedCardIds: string[] }> {
  return withTx(db, async (tx) => {
    const held = await tx
      .select({ id: cardTable.id })
      .from(cardTable)
      .where(eq(cardTable.inventoryId, inventoryId));
    const deleted = await tx
      .delete(inventoryTable)
      .where(and(eq(inventoryTable.namespaceId, namespaceId), eq(inventoryTable.id, inventoryId)))
      .returning({ id: inventoryTable.id });
    assertFound(deleted, `Inventory namespaceId=${namespaceId} inventoryId=${inventoryId}`);
    // The foreign key has already nulled `inventory_id`. The slot is cleared here, since
    // the key knows nothing about it.
    const releasedCardIds = held.map(({ id }) => id);
    await releaseCards(tx, releasedCardIds);
    return { releasedCardIds };
  });
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
 * Puts cards into an inventory, from the canvas or from another inventory, as
 * {@link planStow} plans it. A card leaves its glue group when it is stored.
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

  const held = await tx
    .select({ id: cardTable.id, slot: cardTable.inventorySlot })
    .from(cardTable)
    .where(eq(cardTable.inventoryId, inventoryId));
  const occupants = new Map(
    held.flatMap(({ id, slot: at }) => (at === null ? [] : [[at, id] as const])),
  );
  const plan = planStow(occupants, unique, slot);
  if (plan.some(({ slot: at }) => at > INVENTORY_SLOT_MAX))
    return { ok: false, reason: "inventory-full" };

  // Free every slot the plan writes before filling any, so a swap never meets the unique
  // index halfway through.
  await releaseCards(
    tx,
    plan.map(({ cardId }) => cardId),
  );
  for (const placement of plan)
    await tx
      .update(cardTable)
      .set({ inventoryId, inventorySlot: placement.slot })
      .where(eq(cardTable.id, placement.cardId));

  const heldIds = new Set(held.map(({ id }) => id));
  const clearedCardIds = await unglueCardsInTx({
    db: tx,
    cardIds: plan.map(({ cardId }) => cardId).filter((id) => !heldIds.has(id)),
  });
  return {
    ok: true,
    placements: plan.map((placement) => ({ ...placement, inventoryId })),
    clearedCardIds,
  };
}

/** A card leaving its inventory, and where on the canvas it goes. */
export type TakenCard = { cardId: string; posX?: number; posY?: number };

/**
 * Puts stored cards back on the canvas. A card given a position goes there. One without
 * goes back to where it was before it was stored. Cards already on the canvas are only moved.
 */
export async function takeCards({
  db,
  namespaceId,
  cards,
}: NeedsNamespace & { db: DB; cards: TakenCard[] }): Promise<CardBatchResult> {
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
    await releaseCards(
      tx,
      unique.map(({ cardId }) => cardId),
    );
    for (const { cardId, posX, posY } of unique) {
      if (posX === undefined && posY === undefined) continue;
      await tx
        .update(cardTable)
        .set({ ...(posX !== undefined && { posX }), ...(posY !== undefined && { posY }) })
        .where(eq(cardTable.id, cardId));
    }
    return { ok: true };
  });
}
