/** Inventory rows: reading, creating, renaming, moving, and deleting them. */
import { cardTable, inventoryTable } from "../../schema.js";
import { and, asc, count, eq } from "drizzle-orm";
import type {
  Inventory,
  NeedsInventory,
  NeedsNamespace,
  NeedsNamespaceInventory,
  NeedsTx,
  ReadsNamespace,
} from "../types.js";
import { nextSquashInventoryName } from "../../../lib/squash.js";
import { assertFound, assertNameWithinLimit } from "../utils.js";
import { withTx, type DB, type Tx } from "../../database.js";
import { releaseCardsInTx } from "./slots.js";

/** A namespace's inventories in creation order, which their UUIDv7 IDs sort in. */
export async function getAllInventories({ db, namespaceId }: ReadsNamespace): Promise<Inventory[]> {
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

/** How many cards each of a namespace's inventories holds. Empty inventories are left out. */
export async function getInventoryCardCounts({
  db,
  namespaceId,
}: NeedsNamespace): Promise<Map<string, number>> {
  const rows = await db
    .select({ inventoryId: inventoryTable.id, cards: count(cardTable.id) })
    .from(inventoryTable)
    .innerJoin(cardTable, eq(cardTable.inventoryId, inventoryTable.id))
    .where(eq(inventoryTable.namespaceId, namespaceId))
    .groupBy(inventoryTable.id);
  return new Map(rows.map(({ inventoryId, cards }) => [inventoryId, cards]));
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

/**
 * Add an inventory named after the namespace's next free "Squash N", to hold a squashed card's
 * pieces. Call inside the squash's transaction so two squashes cannot take the same number.
 */
export async function addSquashInventoryInTx({
  db: tx,
  namespaceId,
  posX,
  posY,
}: NeedsTx & { namespaceId: string; posX: number; posY: number }): Promise<Inventory> {
  const existing = await tx
    .select({ name: inventoryTable.name })
    .from(inventoryTable)
    .where(eq(inventoryTable.namespaceId, namespaceId));
  const name = nextSquashInventoryName(existing.map(({ name }) => name));
  return addInventory({ db: tx, namespaceId, name, posX, posY });
}

type UpdateInventory = NeedsNamespaceInventory & {
  name?: string;
  position?: { posX: number; posY: number };
};

/**
 * Move or rename an inventory and return the saved row. Use its clamped coordinates
 * to update the icon after dragging.
 */
export async function updateInventory({
  db,
  namespaceId,
  inventoryId,
  name,
  position,
}: UpdateInventory): Promise<Inventory> {
  if (name !== undefined) assertNameWithinLimit(name, "Inventory name");
  const fields = { ...(name !== undefined && { name }), ...position };
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

/**
 * Delete an inventory and return its cards to their previous canvas positions.
 * Return the card IDs so callers can update the board.
 */
export async function deleteInventory(
  args: NeedsNamespaceInventory & { db: DB },
): Promise<{ releasedCardIds: string[] }> {
  return withTx(args.db, (tx) => deleteInventoryInTx({ ...args, db: tx }));
}
export async function deleteInventoryInTx({
  db: tx,
  namespaceId,
  inventoryId,
}: NeedsNamespaceInventory & { db: Tx }): Promise<{ releasedCardIds: string[] }> {
  return (async () => {
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
    await releaseCardsInTx({ db: tx, cardIds: releasedCardIds });
    return { releasedCardIds };
  })();
}
