import { cardTable, glueRelTable, inventoryTable } from "../schema.js";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
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
import {
  caseUpdateBatches,
  cardsBelongToNamespace,
  isStored,
  writeCardPositionsInTx,
} from "./card.js";
import { unglueCardsInTx } from "./glue.js";
import { assertFound, assertNameWithinLimit, readByIds, type BatchResult } from "./utils.js";
import { withTx, type DB, type Tx } from "../tx.js";

/** A namespace's inventories in creation order, which their UUIDv7 IDs sort in. */
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
 * Write planned slots for one inventory. Clear all affected slots before filling any to
 * avoid unique-index conflicts when cards exchange slots. Apply each batch in one CASE
 * update using the plan's distinct destination slots.
 */
async function writePlacements(
  tx: Tx,
  inventoryId: string,
  plan: readonly SlotPlacement[],
): Promise<void> {
  await releaseCardsInTx(
    tx,
    plan.map(({ cardId }) => cardId),
  );
  // One CASE-updated column. `inventoryId` binds once per statement.
  for (const batch of caseUpdateBatches([...plan], 1)) {
    const whens = batch.map(({ cardId, slot }) => sql`WHEN ${cardId} THEN ${slot}`);
    await tx
      .update(cardTable)
      .set({
        inventoryId,
        // `releaseCardsInTx` just cleared the slot, so ELSE keeps that null rather than a value.
        inventorySlot: sql`CASE ${cardTable.id} ${sql.join(whens, sql` `)} ELSE ${cardTable.inventorySlot} END`,
      })
      .where(
        inArray(
          cardTable.id,
          batch.map(({ cardId }) => cardId),
        ),
      );
  }
}

/**
 * Read inventory footprints and plan repairs for overlapping cards without writing changes.
 * Imports and layout changes can create overlaps because card spans depend on text and
 * layout constants. Writers use the repaired footprints and commit the repairs with their
 * own changes. A refused operation leaves the inventory unchanged.
 */
async function settledFootprints(
  tx: Tx,
  inventoryId: string,
): Promise<{ held: Footprint[]; repaired: SlotPlacement[] }> {
  const held = await heldFootprints(tx, inventoryId);
  const repaired = planRepair(held);
  return { held: withSlots(held, repaired), repaired };
}

/**
 * Merge sequential placement plans into one write. Include each card once and use its slot
 * from `then` when both plans move it.
 */
function mergedPlans(
  first: readonly SlotPlacement[],
  then: readonly SlotPlacement[],
): SlotPlacement[] {
  const final = new Map([...first, ...then].map(({ cardId, slot }) => [cardId, slot]));
  return [...final].map(([cardId, slot]) => ({ cardId, slot }));
}

/** `held` with planned slots applied to the cards named in `plan`. */
function withSlots(held: readonly Footprint[], plan: readonly SlotPlacement[]): Footprint[] {
  const slotOf = new Map(plan.map(({ cardId, slot }) => [cardId, slot]));
  return held.map((f) => ({ ...f, slot: slotOf.get(f.cardId) ?? f.slot }));
}

/** What {@link repairInventories} changed. */
export type InventoryRepair = {
  /** Cards moved so that none overlaps another. */
  moved: InventoryPlacement[];
  /** Stored cards taken out of the glue groups they were still in. */
  unglued: string[];
};

/**
 * Repair every inventory using {@link planRepair} and remove stored cards from glue groups.
 * Return moved cards and stored cards removed from glue groups.
 * After repair, {@link findInventoryConflicts} should find no conflicts.
 */
export async function repairInventories({ db }: { db: DB }): Promise<InventoryRepair> {
  return withTx(db, async (tx) => {
    const inventories = await tx.select({ id: inventoryTable.id }).from(inventoryTable);
    const moved: InventoryPlacement[] = [];
    for (const { id: inventoryId } of inventories) {
      const { repaired } = await settledFootprints(tx, inventoryId);
      if (repaired.length > 0) await writePlacements(tx, inventoryId, repaired);
      moved.push(...repaired.map((p) => ({ ...p, inventoryId })));
    }
    const glued = await tx
      .select({ cardId: glueRelTable.cardId })
      .from(glueRelTable)
      .innerJoin(cardTable, eq(cardTable.id, glueRelTable.cardId))
      .where(isStored);
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

/** Find stored cards that overlap or belong to glue groups across the workspace. */
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
    .where(isStored);
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

/** What {@link refitStoredCardInTx} moved. */
export type Refit = {
  /** Where the edited card went, or null when it stayed put or is not stored. */
  moved: InventoryPlacement | null;
  /** Every card whose slot changed, the edited one and any neighbour a repair moved. */
  placements: InventoryPlacement[];
};

/**
 * Move an edited stored card to the first available slot if its new size overlaps another
 * card. Call this inside the transaction that changed the text.
 */
export async function refitStoredCardInTx({
  db: tx,
  cardId,
}: {
  db: Tx;
  cardId: string;
}): Promise<Refit> {
  const card = await tx
    .select({ inventoryId: cardTable.inventoryId })
    .from(cardTable)
    .where(eq(cardTable.id, cardId))
    .get();
  if (!card?.inventoryId) return { moved: null, placements: [] };
  const { inventoryId } = card;
  // Repair the rest first, leaving this card to the refit, so its longer text moves it rather
  // than the neighbour it now covers.
  const held = await heldFootprints(tx, inventoryId);
  const repaired = planRepair(held.filter((f) => f.cardId !== cardId));
  // A repaired neighbour can land on this card's cells, top slot included. The refit then
  // moves this card, and both go in one write, which frees every slot before filling any.
  const [moved]: SlotPlacement[] = planRefit(withSlots(held, repaired), cardId);
  const plan = moved ? [...repaired, moved] : repaired;
  if (plan.length > 0) await writePlacements(tx, inventoryId, plan);
  return {
    moved: moved ? { ...moved, inventoryId } : null,
    placements: plan.map((p) => ({ ...p, inventoryId })),
  };
}

/**
 * Remove cards from their inventories and clear both inventory columns together.
 * Preserve their previous canvas positions for when they leave storage.
 */
export async function releaseCardsInTx(tx: Tx, cardIds: string[]): Promise<void> {
  for (const batch of chunked(cardIds, { size: BATCH_MAX }))
    await tx
      .update(cardTable)
      .set({ inventoryId: null, inventorySlot: null })
      .where(inArray(cardTable.id, batch));
}

/**
 * Delete an inventory and return its cards to their previous canvas positions.
 * Return the card IDs so callers can update the board.
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
    await releaseCardsInTx(tx, releasedCardIds);
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
  // Checked before anything is written, so a refusal leaves the inventory as it was, overlap
  // and all, rather than committing half the work.
  if (plan.some(({ cardId, slot: at }) => lastCell(at, spans.get(cardId)!) > INVENTORY_SLOT_MAX))
    return { ok: false, reason: "inventory-full" };

  // The repair and the stow go in one write. A card the repair moved and the plan then moved
  // again is named once, where it ended up.
  const final = mergedPlans(repaired, plan);
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
    await releaseCardsInTx(tx, cardIds);
    await writeCardPositionsInTx(
      tx,
      unique.flatMap(({ cardId, position }) => (position ? [{ cardId, ...position }] : [])),
    );
    return { ok: true };
  });
}
