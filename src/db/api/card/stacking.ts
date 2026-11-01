/** Card stacking: layer moves and front/back reordering. */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { cardTable, layerTable } from "../../schema.js";
import type { NeedsTx } from "../types.js";
import { compareIds } from "../../../lib/order.js";
import { readByIds, type BatchResult } from "../utils.js";
import { withTx, type DB, type Tx } from "../../tx.js";
import { cardsBelongToNamespace } from "./read.js";
import { caseUpdateBatches } from "./case-update.js";

type ReassignCardsToLayer = {
  db: DB;
  namespaceId: string;
  cardIds: string[];
  layerId: string;
};

export type CardStacking = { cardId: string; zIndex: number };
/**
 * Distinguish invalid card ownership from an invalid destination layer so callers can report
 * the correct failure.
 */
export type ReassignLayerResult = BatchResult<
  "foreign-cards" | "foreign-layer",
  { stacking: CardStacking[] }
>;

// Same shape as buildPositionCaseWhen, including the ELSE, and for the same reason.
function buildZIndexCaseWhen(stacking: CardStacking[]): SQL {
  const whens = stacking.map((s) => sql`WHEN ${s.cardId} THEN ${s.zIndex}`);
  return sql`CASE ${cardTable.id} ${sql.join(whens, sql` `)} ELSE ${cardTable.zIndex} END`;
}

/**
 * Write one batch of zIndex values. Assert the row count as the position update does, so a
 * card missing from the batch fails the transaction instead of being skipped silently.
 */
async function writeStacking(
  tx: Tx,
  batch: CardStacking[],
  extra: Partial<Pick<typeof cardTable.$inferInsert, "layerId">> = {},
): Promise<void> {
  const updated = await tx
    .update(cardTable)
    .set({ ...extra, zIndex: buildZIndexCaseWhen(batch) })
    .where(
      inArray(
        cardTable.id,
        batch.map(({ cardId }) => cardId),
      ),
    )
    .returning({ id: cardTable.id });
  if (updated.length !== batch.length)
    throw new Error(`writeStacking: expected ${batch.length} updates, got ${updated.length}`);
}

/** Read each requested card's layer and stacking value in batches. */
function readStackRows(
  tx: Tx,
  cardIds: string[],
): Promise<{ id: string; layerId: string; zIndex: number }[]> {
  return readByIds([...new Set(cardIds)], (batch) =>
    tx
      .select({ id: cardTable.id, layerId: cardTable.layerId, zIndex: cardTable.zIndex })
      .from(cardTable)
      .where(inArray(cardTable.id, batch)),
  );
}

/**
 * Read a layer's highest and lowest zIndex with SQL aggregates. Include 0 in the range so
 * an empty layer has a starting value.
 */
async function layerStackBounds(tx: Tx, layerId: string): Promise<{ top: number; bottom: number }> {
  const row = await tx
    .select({
      top: sql<number | null>`max(${cardTable.zIndex})`,
      bottom: sql<number | null>`min(${cardTable.zIndex})`,
    })
    .from(cardTable)
    .where(eq(cardTable.layerId, layerId))
    .get();
  return { top: Math.max(row?.top ?? 0, 0), bottom: Math.min(row?.bottom ?? 0, 0) };
}

/**
 * {@link layerStackBounds} for several layers in one grouped query. A layer with no cards is
 * absent from the result and reads as `{ top: 0, bottom: 0 }`.
 */
async function layerStackBoundsByLayer(
  tx: Tx,
  layerIds: string[],
): Promise<Map<string, { top: number; bottom: number }>> {
  const rows = await readByIds(layerIds, (batch) =>
    tx
      .select({
        layerId: cardTable.layerId,
        top: sql<number>`max(${cardTable.zIndex})`,
        bottom: sql<number>`min(${cardTable.zIndex})`,
      })
      .from(cardTable)
      .where(inArray(cardTable.layerId, batch))
      .groupBy(cardTable.layerId),
  );
  return new Map(
    rows.map(({ layerId, top, bottom }) => [
      layerId,
      { top: Math.max(top, 0), bottom: Math.min(bottom, 0) },
    ]),
  );
}

/** The zIndex that puts a new card above every card on `layerId`. */
export async function nextLayerZIndexInTx({
  db: tx,
  layerId,
}: NeedsTx & { layerId: string }): Promise<number> {
  return (await layerStackBounds(tx, layerId)).top + 1;
}

/**
 * Move cards to another layer in the same namespace. Reject cards or a destination layer
 * outside that namespace.
 *
 * Restack arriving cards above the destination's existing cards while preserving their
 * relative order. Leave cards already on the destination layer unchanged. Return the assigned
 * stacking values for client state updates.
 */
export async function reassignCardsToLayer({
  db,
  namespaceId,
  cardIds,
  layerId,
}: ReassignCardsToLayer): Promise<ReassignLayerResult> {
  if (cardIds.length === 0) return { ok: true, stacking: [] };
  return withTx(db, (tx) => reassignCardsToLayerInTx({ db: tx, namespaceId, cardIds, layerId }));
}

/**
 * {@link reassignCardsToLayer} inside a caller-owned transaction, for routes that combine a
 * layer move with other writes atomically.
 */
export async function reassignCardsToLayerInTx({
  db: tx,
  namespaceId,
  cardIds,
  layerId,
}: NeedsTx & Omit<ReassignCardsToLayer, "db">): Promise<ReassignLayerResult> {
  if (cardIds.length === 0) return { ok: true, stacking: [] };
  // Check the destination first so a request with both an invalid layer and invalid cards
  // reports the layer error consistently.
  const layer = await tx
    .select({ id: layerTable.id })
    .from(layerTable)
    .where(and(eq(layerTable.id, layerId), eq(layerTable.namespaceId, namespaceId)))
    .get();
  if (!layer) return { ok: false, reason: "foreign-layer" };

  const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
  if (!owned.ok) return owned;

  const requested = await readStackRows(tx, cardIds);
  const arriving = requested.filter((card) => card.layerId !== layerId);
  if (arriving.length === 0) return { ok: true, stacking: [] };

  const { top } = await layerStackBounds(tx, layerId);

  // Preserve relative stacking order, using IDs to break ties.
  const stacking = [...arriving]
    .sort((a, b) => a.zIndex - b.zIndex || compareIds(a.id, b.id))
    .map((card, index) => ({ cardId: card.id, zIndex: top + 1 + index }));

  // Only zIndex uses a CASE expression. `layerId` binds once per statement.
  for (const batch of caseUpdateBatches(stacking, 1)) await writeStacking(tx, batch, { layerId });

  return { ok: true, stacking };
}

type ReassignCardsStackOrder = {
  db: DB;
  namespaceId: string;
  cardIds: string[];
  direction: "front" | "back";
};

/** Some cards in the glue group do not belong to this namespace. */
export type ReassignStackOrderResult = BatchResult<"foreign-cards", { stacking: CardStacking[] }>;

/**
 * Move cards together to the front or back of their current layers.
 *
 * Group by layer because a glue group can span layers. Preserve relative order within each
 * group and assign consecutive values above or below the existing stack.
 */
export async function reassignCardsStackOrder({
  db,
  namespaceId,
  cardIds,
  direction,
}: ReassignCardsStackOrder): Promise<ReassignStackOrderResult> {
  if (cardIds.length === 0) return { ok: true, stacking: [] };

  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;

    const requested = await readStackRows(tx, cardIds);

    const byLayer = new Map<string, typeof requested>();
    for (const card of requested) {
      const group = byLayer.get(card.layerId);
      if (group) group.push(card);
      else byLayer.set(card.layerId, [card]);
    }

    const bounds = await layerStackBoundsByLayer(tx, [...byLayer.keys()]);
    const stacking: CardStacking[] = [];
    for (const [layerId, group] of byLayer) {
      const { top, bottom } = bounds.get(layerId) ?? { top: 0, bottom: 0 };

      const ordered = [...group].sort((a, b) => a.zIndex - b.zIndex || compareIds(a.id, b.id));
      if (direction === "front") {
        ordered.forEach((card, index) =>
          stacking.push({ cardId: card.id, zIndex: top + 1 + index }),
        );
      } else {
        // Assign values from bottom to top to preserve the group's relative order.
        const n = ordered.length;
        ordered.forEach((card, index) =>
          stacking.push({ cardId: card.id, zIndex: bottom - (n - index) }),
        );
      }
    }

    for (const batch of caseUpdateBatches(stacking, 1)) await writeStacking(tx, batch);

    return { ok: true, stacking };
  });
}
