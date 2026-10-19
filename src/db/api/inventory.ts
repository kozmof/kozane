import { cardTable, glueRelTable, inventoryTable } from "../schema.js";
import { and, asc, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type {
  Inventory,
  NeedsDB,
  NeedsInventory,
  NeedsNamespace,
  NeedsNamespaceInventory,
} from "./types.js";
import { BATCH_MAX, INVENTORY_SLOT_MAX, chunked } from "../../lib/constants.js";
import {
  INVENTORY_SPAN_SOURCE_CHARS,
  cardSpan,
  lastCell,
  overlappingCards,
  planRefit,
  planRepair,
  planStow,
  type Footprint,
  type InventoryPlacement,
  type SlotPlacement,
  type TakenCard,
} from "../../lib/inventory.js";
import { cardsBelongToNamespace } from "./card.js";
import { unglueCardsInTx } from "./glue.js";
import { assertFound, assertNameWithinLimit, readByIds, type BatchResult } from "./utils.js";
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

/**
 * The opening of a card's text, which is all {@link cardSpan} reads. Bounded so sizing a full
 * inventory does not pull every card's whole text.
 */
const SPAN_TEXT = sql<string>`substr(${cardTable.content}, 1, ${INVENTORY_SPAN_SOURCE_CHARS})`;

/** What one inventory holds, each card sized by its text. */
async function heldFootprints(tx: Tx, inventoryId: string): Promise<Footprint[]> {
  const rows = await tx
    .select({ cardId: cardTable.id, slot: cardTable.inventorySlot, text: SPAN_TEXT })
    .from(cardTable)
    .where(eq(cardTable.inventoryId, inventoryId));
  return rows.flatMap(({ cardId, slot, text }) =>
    slot === null ? [] : [{ cardId, slot, span: cardSpan(text) }],
  );
}

/**
 * Writes cards into slots of one inventory. Every slot the plan writes is freed before any is
 * filled, so cards trading places never meet the unique index halfway through.
 */
async function writePlacements(
  tx: Tx,
  inventoryId: string,
  plan: readonly SlotPlacement[],
): Promise<void> {
  await releaseCards(
    tx,
    plan.map(({ cardId }) => cardId),
  );
  for (const { cardId, slot } of plan)
    await tx
      .update(cardTable)
      .set({ inventoryId, inventorySlot: slot })
      .where(eq(cardTable.id, cardId));
}

/**
 * What one inventory holds, with any overlap repaired first. Spans come from text and the
 * layout constants, so an upgrade that changes the layout or an imported dump can leave cards
 * overlapping. Every writer plans from this, so the first write to an inventory repairs it.
 */
async function settledFootprints(
  tx: Tx,
  inventoryId: string,
  /** A card the caller places itself, such as one whose text just changed. Never moved here. */
  except?: string,
): Promise<{ held: Footprint[]; repaired: SlotPlacement[] }> {
  const held = await heldFootprints(tx, inventoryId);
  const repaired = planRepair(held.filter(({ cardId }) => cardId !== except));
  if (repaired.length === 0) return { held, repaired };
  await writePlacements(tx, inventoryId, repaired);
  const slotOf = new Map(repaired.map(({ cardId, slot }) => [cardId, slot]));
  return {
    held: held.map((f) => ({ ...f, slot: slotOf.get(f.cardId) ?? f.slot })),
    repaired,
  };
}

/** What {@link repairInventories} changed. */
export type InventoryRepair = {
  /** Cards moved so that none overlaps another. */
  moved: InventoryPlacement[];
  /** Stored cards taken out of the glue groups they were still in. */
  unglued: string[];
};

/**
 * Repairs every inventory in the workspace: moves overlapping cards apart, as
 * {@link planRepair} plans it, and takes stored cards out of their glue groups. Reports the
 * same cards {@link findInventoryConflicts} finds, and leaves nothing for it to find.
 */
export async function repairInventories({ db }: { db: DB }): Promise<InventoryRepair> {
  return withTx(db, async (tx) => {
    const inventories = await tx.select({ id: inventoryTable.id }).from(inventoryTable);
    const moved: InventoryPlacement[] = [];
    for (const { id: inventoryId } of inventories) {
      const { repaired } = await settledFootprints(tx, inventoryId);
      moved.push(...repaired.map((p) => ({ ...p, inventoryId })));
    }
    const glued = await tx
      .select({ cardId: glueRelTable.cardId })
      .from(glueRelTable)
      .innerJoin(cardTable, eq(cardTable.id, glueRelTable.cardId))
      .where(isNotNull(cardTable.inventoryId));
    const stored = glued.map(({ cardId }) => cardId);
    // Ungluing can dissolve a group, which also frees partners left on the canvas. Only the
    // stored cards are reported, since those are what was wrong.
    await unglueCardsInTx({ db: tx, cardIds: stored });
    return { moved, unglued: stored };
  });
}

/** Stored cards that break an inventory rule, for `kozane doctor`. */
export type InventoryConflicts = {
  /** Cards covering a cell another card of their inventory covers. */
  overlapping: string[];
  /** Stored cards still in a glue group, which storing a card ends. */
  glued: string[];
};

/** Finds stored cards that overlap or are glued, across the whole workspace. */
export async function findInventoryConflicts({ db }: NeedsDB): Promise<InventoryConflicts> {
  const rows = await db
    .select({
      cardId: cardTable.id,
      inventoryId: cardTable.inventoryId,
      slot: cardTable.inventorySlot,
      text: SPAN_TEXT,
      glueId: glueRelTable.glueId,
    })
    .from(cardTable)
    .leftJoin(glueRelTable, eq(glueRelTable.cardId, cardTable.id))
    .where(isNotNull(cardTable.inventoryId));
  const byInventory = new Map<string, Footprint[]>();
  for (const { cardId, inventoryId, slot, text } of rows) {
    if (inventoryId === null || slot === null) continue;
    const held = byInventory.get(inventoryId) ?? [];
    held.push({ cardId, slot, span: cardSpan(text) });
    byInventory.set(inventoryId, held);
  }
  return {
    overlapping: [...byInventory.values()].flatMap(overlappingCards),
    glued: rows.flatMap(({ cardId, glueId }) => (glueId === null ? [] : [cardId])),
  };
}

/** The named cards sized by their text, in the order named. */
async function sizedCards(tx: Tx, cardIds: string[]): Promise<{ cardId: string; span: number }[]> {
  const rows = await readByIds(cardIds, (batch) =>
    tx
      .select({ cardId: cardTable.id, text: SPAN_TEXT })
      .from(cardTable)
      .where(inArray(cardTable.id, batch)),
  );
  const spanOf = new Map(rows.map(({ cardId, text }) => [cardId, cardSpan(text)]));
  return cardIds.flatMap((cardId) => {
    const span = spanOf.get(cardId);
    return span === undefined ? [] : [{ cardId, span }];
  });
}

/**
 * Moves a stored card whose text changed, if it now covers cells another card holds, to the
 * first place it fits. Call it in the transaction that changed the text. Returns where it
 * went, or null when it stayed put or is not stored.
 */
export async function refitStoredCardInTx({
  db: tx,
  cardId,
}: {
  db: Tx;
  cardId: string;
}): Promise<InventoryPlacement | null> {
  const card = await tx
    .select({ inventoryId: cardTable.inventoryId })
    .from(cardTable)
    .where(eq(cardTable.id, cardId))
    .get();
  if (!card?.inventoryId) return null;
  const { inventoryId } = card;
  // Repair the rest first, leaving this card to the refit, so its longer text moves it rather
  // than the neighbour it now covers. A repaired neighbour reaches the board with the next poll.
  const { held } = await settledFootprints(tx, inventoryId, cardId);
  const [moved]: SlotPlacement[] = planRefit(held, cardId);
  if (!moved) return null;
  // The new slot is free, so moving there in one write never meets the unique index.
  await tx.update(cardTable).set({ inventorySlot: moved.slot }).where(eq(cardTable.id, cardId));
  return { ...moved, inventoryId };
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

  const { held, repaired } = await settledFootprints(tx, inventoryId);
  const moving = await sizedCards(tx, unique);
  const plan = planStow(held, moving, slot);
  const spans = new Map([...held, ...moving].map(({ cardId, span }) => [cardId, span]));
  // A refusal does not throw, so a transaction that commits anyway keeps the repair made
  // above. That is fine, since the repair stands on its own.
  if (plan.some(({ cardId, slot: at }) => lastCell(at, spans.get(cardId)!) > INVENTORY_SLOT_MAX))
    return { ok: false, reason: "inventory-full" };

  await writePlacements(tx, inventoryId, plan);

  const heldIds = new Set(held.map(({ cardId }) => cardId));
  const clearedCardIds = await unglueCardsInTx({
    db: tx,
    cardIds: plan.map(({ cardId }) => cardId).filter((id) => !heldIds.has(id)),
  });
  // A card the repair moved and the plan then moved again is named once, where it ended up.
  const final = new Map([...repaired, ...plan].map(({ cardId, slot: at }) => [cardId, at]));
  return {
    ok: true,
    placements: [...final].map(([cardId, at]) => ({ cardId, slot: at, inventoryId })),
    clearedCardIds,
  };
}

/** Refusals for a take. `unstored-cards` means a named card is not in any inventory. */
export type TakeResult = BatchResult<"foreign-cards" | "unstored-cards">;

/**
 * Puts stored cards back on the canvas. A card given a position goes there. One without
 * goes back to where it was before it was stored. A card already on the canvas is refused,
 * since moving it here would skip the grid snap and leave its glue group behind.
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
        .where(and(inArray(cardTable.id, batch), isNotNull(cardTable.inventoryId))),
    );
    if (stored.length !== cardIds.length) return { ok: false, reason: "unstored-cards" };
    await releaseCards(tx, cardIds);
    for (const card of unique) {
      if (!("posX" in card)) continue;
      await tx
        .update(cardTable)
        .set({ posX: card.posX, posY: card.posY })
        .where(eq(cardTable.id, card.cardId));
    }
    return { ok: true };
  });
}
