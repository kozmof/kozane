/** Slot bookkeeping shared by stowing, refitting, and repair. */
import { cardTable } from "../../schema.js";
import { eq, inArray, sql } from "drizzle-orm";
import type { NeedsTx } from "../types.js";
import { BATCH_MAX, chunked } from "../../../lib/constants.js";
import {
  INVENTORY_SPAN_SOURCE_CHARS,
  cardSpan,
  planRepair,
  type Footprint,
  type SlotPlacement,
} from "../../../lib/inventory.js";
import { caseUpdateBatches, inventoryColumns } from "../card.js";
import { readByIds } from "../utils.js";
import { type Tx } from "../../tx.js";

/**
 * The opening of a card's text, which is all {@link cardSpan} reads. Bounded so sizing a full
 * inventory does not pull every card's whole text.
 */
export const SPAN_TEXT = sql<string>`substr(${cardTable.content}, 1, ${INVENTORY_SPAN_SOURCE_CHARS})`;

/** What one inventory holds, each card sized by its text. */
export async function heldFootprints(tx: Tx, inventoryId: string): Promise<Footprint[]> {
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
export async function writePlacements(
  tx: Tx,
  inventoryId: string,
  plan: readonly SlotPlacement[],
): Promise<void> {
  await releaseCardsInTx({ db: tx, cardIds: plan.map(({ cardId }) => cardId) });
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
export async function settledFootprints(
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
export function mergedPlans(
  first: readonly SlotPlacement[],
  then: readonly SlotPlacement[],
): SlotPlacement[] {
  const final = new Map([...first, ...then].map(({ cardId, slot }) => [cardId, slot]));
  return [...final].map(([cardId, slot]) => ({ cardId, slot }));
}

/** `held` with planned slots applied to the cards named in `plan`. */
export function withSlots(held: readonly Footprint[], plan: readonly SlotPlacement[]): Footprint[] {
  const slotOf = new Map(plan.map(({ cardId, slot }) => [cardId, slot]));
  return held.map((f) => ({ ...f, slot: slotOf.get(f.cardId) ?? f.slot }));
}

/** The named cards sized by their text, in the order named. */
export async function sizedCards(
  tx: Tx,
  cardIds: string[],
): Promise<{ cardId: string; span: number }[]> {
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
 * Remove cards from their inventories and clear both inventory columns together.
 * Preserve their previous canvas positions for when they leave storage.
 */
export async function releaseCardsInTx({
  db: tx,
  cardIds,
}: NeedsTx & { cardIds: string[] }): Promise<void> {
  for (const batch of chunked(cardIds, { size: BATCH_MAX }))
    await tx.update(cardTable).set(inventoryColumns(null)).where(inArray(cardTable.id, batch));
}
