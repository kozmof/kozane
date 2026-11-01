/** Card inserts, with the namespace checks foreign keys cannot make. */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  cardTable,
  inventoryTable,
  layerTable,
  partitionTable,
  taskspaceTable,
} from "../../schema.js";
import type { NeedsPartition, NeedsTx } from "../types.js";
import type { CardData } from "../../../lib/types.js";
import { INVENTORY_SLOT_MAX, chunked } from "../../../lib/constants.js";
import { cardSpan, lastCell, overlappingCards, type Footprint } from "../../../lib/inventory.js";
import { NotFoundError, columnCount, readByIds } from "../utils.js";
import { withTx, type DB } from "../../tx.js";
import { heldFootprints } from "../inventory/slots.js";
import { defaultLayerIdForPartition } from "./read.js";
import { inventoryColumns } from "./placement.js";
import { nextLayerZIndexInTx } from "./stacking.js";

type AddCardFields = {
  partitionId: string;
  content: string;
  layerId?: string;
  taskspaceId?: string;
  posX?: number;
  posY?: number;
  zIndex?: number;
};
type AddCard = { db: DB } & AddCardFields;
type AddCardInTx = NeedsTx & AddCardFields;
/**
 * Create both card timestamps from one clock reading. Per-column defaults could cross a
 * second boundary and make a new card appear edited.
 *
 * Call once per batch so cards created together also share timestamps across insert
 * statements.
 */
export function newCardStamps(): { createdAt: Date; updatedAt: Date } {
  const now = new Date();
  return { createdAt: now, updatedAt: now };
}

/**
 * Refuse a layer outside the partition's namespace. Foreign keys only check that both rows
 * exist, so without this a caller could put a card on another namespace's layer.
 */
async function assertLayerMatchesPartition({
  db,
  partitionId,
  layerId,
}: NeedsPartition & { layerId: string }): Promise<void> {
  const row = await db
    .select({ id: layerTable.id })
    .from(layerTable)
    .innerJoin(partitionTable, eq(partitionTable.namespaceId, layerTable.namespaceId))
    .where(and(eq(partitionTable.id, partitionId), eq(layerTable.id, layerId)))
    .get();
  if (!row)
    throw new NotFoundError(
      `Layer layerId=${layerId} in the namespace of partitionId=${partitionId}`,
    );
}

/**
 * Refuse a taskspace placed in another namespace. An unplaced taskspace appears on every
 * board, so it can link cards in any namespace.
 */
async function assertTaskspaceMatchesPartition({
  db,
  partitionId,
  taskspaceId,
}: NeedsPartition & { taskspaceId: string }): Promise<void> {
  const row = await db
    .select({ id: taskspaceTable.id })
    .from(taskspaceTable)
    .innerJoin(partitionTable, eq(partitionTable.id, partitionId))
    .where(
      and(
        eq(taskspaceTable.id, taskspaceId),
        or(
          isNull(taskspaceTable.namespaceId),
          eq(taskspaceTable.namespaceId, partitionTable.namespaceId),
        ),
      ),
    )
    .get();
  if (!row)
    throw new NotFoundError(
      `Taskspace taskspaceId=${taskspaceId} in the namespace of partitionId=${partitionId}`,
    );
}

/**
 * Refuse an inventory outside the partition's namespace. As with layers, the foreign key only
 * checks that the row exists.
 */
async function assertInventoriesMatchPartition({
  db,
  partitionId,
  inventoryIds,
}: NeedsPartition & { inventoryIds: string[] }): Promise<void> {
  const wanted = [...new Set(inventoryIds)];
  if (wanted.length === 0) return;
  const found = await readByIds(wanted, (batch) =>
    db
      .select({ id: inventoryTable.id })
      .from(inventoryTable)
      .innerJoin(partitionTable, eq(partitionTable.namespaceId, inventoryTable.namespaceId))
      .where(and(eq(partitionTable.id, partitionId), inArray(inventoryTable.id, batch))),
  );
  if (found.length !== wanted.length) {
    const present = new Set(found.map(({ id }) => id));
    const missing = wanted.find((id) => !present.has(id));
    throw new NotFoundError(
      `Inventory inventoryId=${missing} in the namespace of partitionId=${partitionId}`,
    );
  }
}

/**
 * Refuse planned inventory slots that would not fit. The unique index only stops two cards
 * from starting on the same slot. A card that spans several rows can still cover a cell
 * another card starts on, or run past {@link INVENTORY_SLOT_MAX}. Check every new card
 * together with the cards each inventory already holds.
 */
async function assertSlotsFit(
  tx: NeedsTx["db"],
  cards: { content: string; inventory?: NonNullable<CardData["inventory"]> }[],
): Promise<void> {
  const incoming = new Map<string, Footprint[]>();
  for (const [index, { content, inventory }] of cards.entries()) {
    if (!inventory) continue;
    const { id, slot } = inventory;
    if (!Number.isSafeInteger(slot) || slot < 0)
      throw new Error(`Card ${index + 1}: inventory slot must be a non-negative integer`);
    const span = cardSpan(content);
    if (lastCell(slot, span) > INVENTORY_SLOT_MAX)
      throw new Error(`Card ${index + 1}: inventory slot ${slot} runs past the last slot`);
    // New cards have no ID yet, so key them by input position.
    const footprints = incoming.get(id) ?? [];
    footprints.push({ cardId: `new:${index}`, slot, span });
    incoming.set(id, footprints);
  }
  for (const [inventoryId, footprints] of incoming) {
    const held = await heldFootprints(tx, inventoryId);
    if (overlappingCards([...held, ...footprints]).length > 0)
      throw new Error(`Cards overlap in inventory inventoryId=${inventoryId}`);
  }
}

/**
 * Insert one card in its own transaction. Routes and commands that combine the insert with
 * other writes call {@link addCardInTx}.
 */
export async function addCard({ db, ...fields }: AddCard): Promise<string> {
  return withTx(db, async (tx) => (await addCardInTx({ db: tx, ...fields })).id);
}

/** The inserted card's ID and the stacking value it was stored with. */
export type AddedCard = { id: string; zIndex: number };

/**
 * {@link addCard} inside a caller-owned transaction. An explicit `layerId` or `taskspaceId`
 * must be in the partition's namespace. Requiring a transaction keeps that check and the
 * insert atomic, so another writer cannot move the layer or taskspace in between.
 *
 * An omitted `zIndex` puts the card above every card on its layer, as the board does, so
 * cards added from the CLI do not land underneath existing ones. The result carries the stored
 * `zIndex`, so callers can report it without resolving that default a second time.
 */
export async function addCardInTx({
  db,
  partitionId,
  content,
  layerId,
  taskspaceId,
  posX,
  posY,
  zIndex,
}: AddCardInTx): Promise<AddedCard> {
  if (layerId !== undefined) await assertLayerMatchesPartition({ db, partitionId, layerId });
  if (taskspaceId !== undefined)
    await assertTaskspaceMatchesPartition({ db, partitionId, taskspaceId });
  const resolvedLayerId = layerId ?? (await defaultLayerIdForPartition({ db, partitionId }));
  const [row] = await db
    .insert(cardTable)
    .values({
      ...newCardStamps(),
      partitionId,
      layerId: resolvedLayerId,
      content,
      taskspaceId,
      ...(posX !== undefined && { posX }),
      ...(posY !== undefined && { posY }),
      zIndex: zIndex ?? (await nextLayerZIndexInTx({ db, layerId: resolvedLayerId })),
    })
    .returning({ id: cardTable.id, zIndex: cardTable.zIndex });
  return row;
}

type AddCardsFields = {
  partitionId: string;
  layerId: string;
  cards: {
    content: string;
    posX: number;
    posY: number;
    /** Store the card straight away in this inventory slot. Omit to put it on the canvas. */
    inventory?: NonNullable<CardData["inventory"]>;
  }[];
};
type AddCards = { db: DB } & AddCardsFields;
type AddCardsInTx = NeedsTx & AddCardsFields;

/**
 * Insert cards in their own transaction. Commands that combine the insert with other writes
 * call {@link addCardsInTx}.
 */
export async function addCards({ db, ...fields }: AddCards): Promise<string[]> {
  return withTx(db, (tx) => addCardsInTx({ db: tx, ...fields }));
}

/**
 * Insert cards into one partition and layer using {@link chunked} statements, stacked above
 * the layer's cards in input order. Any inventory named must be in the partition's namespace,
 * and stored cards must fit beside what it already holds (see {@link assertSlotsFit}).
 * Return IDs in input order.
 *
 * Require a resolved `layerId` to avoid a default-layer lookup for each chunk. Requiring a
 * transaction keeps the stacking read and the inserts atomic.
 */
export async function addCardsInTx({
  db,
  partitionId,
  layerId,
  cards,
}: AddCardsInTx): Promise<string[]> {
  if (cards.length === 0) return [];
  await assertLayerMatchesPartition({ db, partitionId, layerId });
  await assertInventoriesMatchPartition({
    db,
    partitionId,
    inventoryIds: cards.flatMap(({ inventory }) => (inventory ? [inventory.id] : [])),
  });
  await assertSlotsFit(db, cards);
  // Share one timestamp across all chunks. See {@link newCardStamps}.
  const stamps = newCardStamps();
  let zIndex = await nextLayerZIndexInTx({ db, layerId });
  const ids: string[] = [];
  for (const batch of chunked(cards, { columnsPerRow: columnCount(cardTable) })) {
    const rows = await db
      .insert(cardTable)
      .values(
        batch.map(({ inventory, ...card }) => ({
          ...stamps,
          partitionId,
          layerId,
          ...card,
          zIndex: zIndex++,
          ...inventoryColumns(inventory ?? null),
        })),
      )
      .returning({ id: cardTable.id });
    ids.push(...rows.map(({ id }) => id));
  }
  return ids;
}
