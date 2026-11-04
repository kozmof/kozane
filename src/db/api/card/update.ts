/** Card updates: fields, positions, and partition moves. */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { cardTable, layerTable, partitionTable } from "../../schema.js";
import type { NeedsPartition, NeedsTx } from "../types.js";
import { BATCH_MAX, chunked } from "../../../lib/constants.js";
import { NotFoundError, assertFound, type BatchResult, type CardBatchResult } from "../utils.js";
import { withTx, type DB } from "../../database.js";
import { cardsBelongToNamespace } from "./read.js";
import { caseUpdateBatches } from "./case-update.js";

type ReassignPartitionCards = NeedsTx & {
  namespaceId: string;
  fromPartitionId: string;
  toPartitionId: string;
};
/**
 * Move every card from one partition to another in the same namespace. Throw when either
 * partition is outside `namespaceId`, so no caller can move cards across namespaces.
 */
export async function reassignPartitionCards({
  db,
  namespaceId,
  fromPartitionId,
  toPartitionId,
}: ReassignPartitionCards): Promise<void> {
  const ids = [...new Set([fromPartitionId, toPartitionId])];
  const found = await db
    .select({ id: partitionTable.id })
    .from(partitionTable)
    .where(and(inArray(partitionTable.id, ids), eq(partitionTable.namespaceId, namespaceId)));
  if (found.length !== ids.length)
    throw new NotFoundError(`Partitions ${ids.join(", ")} in namespace namespaceId=${namespaceId}`);
  await db
    .update(cardTable)
    .set({ partitionId: toPartitionId })
    .where(eq(cardTable.partitionId, fromPartitionId));
}

type UpdateCardFields = {
  cardId: string;
  partitionId: string;
  newPartitionId?: string;
  layerId?: string;
  content?: string;
  posX?: number;
  posY?: number;
  zIndex?: number;
  /**
   * `null` clears the card's own width, putting it back under `ui.defaultCardWidth`.
   * Undefined preserves the current width setting.
   */
  width?: number | null;
};
type UpdateCard = { db: DB } & UpdateCardFields;
type UpdateCardInTx = NeedsTx & UpdateCardFields;
type CardUpdate = Partial<
  Pick<
    typeof cardTable.$inferInsert,
    "content" | "posX" | "posY" | "zIndex" | "width" | "partitionId" | "layerId"
  >
> & {
  /**
   * Use a SQL expression so the stored row determines whether its timestamp changes. See
   * {@link contentUpdatedAt}.
   */
  updatedAt?: SQL;
};

/**
 * Update the timestamp only when card text changes.
 *
 * Compare against the existing content in the `SET` expression so the decision and write are
 * atomic. Unchanged text must not reset the gap reported by `card list --sort gap`.
 *
 * Take the new time from the same JS clock as {@link newCardStamps}, so creation and edit
 * times never come from two sources. The timestamp column stores whole seconds.
 */
function contentUpdatedAt(content: string): SQL {
  const now = Math.floor(Date.now() / 1000);
  return sql`CASE WHEN ${cardTable.content} <> ${content} THEN ${now} ELSE ${cardTable.updatedAt} END`;
}

/**
 * Refuse a destination partition or layer outside the card's current namespace. Routes check
 * this too, but enforcing it here keeps every caller from moving a card across namespaces.
 */
async function assertSameNamespace({
  db,
  partitionId,
  newPartitionId,
  layerId,
}: NeedsPartition & { newPartitionId?: string; layerId?: string }): Promise<void> {
  const current = await db
    .select({ namespaceId: partitionTable.namespaceId })
    .from(partitionTable)
    .where(eq(partitionTable.id, partitionId))
    .get();
  if (!current) throw new NotFoundError(`Partition partitionId=${partitionId}`);
  const { namespaceId } = current;

  if (newPartitionId !== undefined) {
    const target = await db
      .select({ id: partitionTable.id })
      .from(partitionTable)
      .where(
        and(eq(partitionTable.id, newPartitionId), eq(partitionTable.namespaceId, namespaceId)),
      )
      .get();
    if (!target)
      throw new NotFoundError(
        `Partition partitionId=${newPartitionId} in namespace namespaceId=${namespaceId}`,
      );
  }
  if (layerId !== undefined) {
    const target = await db
      .select({ id: layerTable.id })
      .from(layerTable)
      .where(and(eq(layerTable.id, layerId), eq(layerTable.namespaceId, namespaceId)))
      .get();
    if (!target)
      throw new NotFoundError(`Layer layerId=${layerId} in namespace namespaceId=${namespaceId}`);
  }
}

/**
 * Update one card in its own transaction. Routes and commands that combine the update with
 * other writes call {@link updateCardInTx}.
 */
export async function updateCard({ db, ...fields }: UpdateCard): Promise<void> {
  return withTx(db, (tx) => updateCardInTx({ db: tx, ...fields }));
}

/**
 * {@link updateCard} inside a caller-owned transaction. Requiring one keeps the namespace check
 * and the write atomic, so a partition or layer cannot leave the namespace in between.
 */
export async function updateCardInTx({
  db,
  cardId,
  partitionId,
  newPartitionId,
  layerId,
  content,
  posX,
  posY,
  zIndex,
  width,
}: UpdateCardInTx): Promise<void> {
  const fields: CardUpdate = {};
  // Only text changes update `updatedAt`. Position, width, partition, layer, and stacking
  // changes preserve it.
  if (content !== undefined) {
    fields.content = content;
    fields.updatedAt = contentUpdatedAt(content);
  }
  if (posX !== undefined) fields.posX = posX;
  if (posY !== undefined) fields.posY = posY;
  if (zIndex !== undefined) fields.zIndex = zIndex;
  if (width !== undefined) fields.width = width;
  if (newPartitionId !== undefined) fields.partitionId = newPartitionId;
  if (layerId !== undefined) fields.layerId = layerId;
  if (Object.keys(fields).length === 0) throw new Error("updateCard: no fields to update");
  if (newPartitionId !== undefined || layerId !== undefined)
    await assertSameNamespace({ db, partitionId, newPartitionId, layerId });

  const updated = await db
    .update(cardTable)
    .set(fields)
    .where(and(eq(cardTable.id, cardId), eq(cardTable.partitionId, partitionId)))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card cardId=${cardId}`);
}

export type CardPositionUpdate = {
  cardId: string;
  posX: number;
  posY: number;
};

// Preserve the column value when no WHEN branch matches. This avoids writing NULL if the CASE
// and WHERE lists ever diverge. The row-count check still fails the transaction on an
// incomplete update.
function buildPositionCaseWhen(positions: CardPositionUpdate[]): { posX: SQL; posY: SQL } {
  const whenX = positions.map((p) => sql`WHEN ${p.cardId} THEN ${p.posX}`);
  const whenY = positions.map((p) => sql`WHEN ${p.cardId} THEN ${p.posY}`);
  return {
    posX: sql`CASE ${cardTable.id} ${sql.join(whenX, sql` `)} ELSE ${cardTable.posX} END`,
    posY: sql`CASE ${cardTable.id} ${sql.join(whenY, sql` `)} ELSE ${cardTable.posY} END`,
  };
}

/** Use the last update for each repeated card ID, matching sequential writes. */
function dedupePositions(positions: CardPositionUpdate[]): CardPositionUpdate[] {
  return [...new Map(positions.map((p) => [p.cardId, p])).values()];
}

type UpdateNamespaceCardPositions = {
  db: DB;
  namespaceId: string;
  positions: CardPositionUpdate[];
};

export async function updateNamespaceCardPositions({
  db,
  namespaceId,
  positions,
}: UpdateNamespaceCardPositions): Promise<CardBatchResult> {
  if (positions.length === 0) return { ok: true };
  const unique = dedupePositions(positions);

  return withTx(db, async (tx) => {
    const cardIds = unique.map((p) => p.cardId);
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;

    await writeCardPositionsInTx({ db: tx, positions: unique });
    return { ok: true };
  });
}

/**
 * Writes canvas positions inside a caller-owned transaction, without ownership checks. Each
 * card must appear once. Throws if any card is missing, so the transaction rolls back.
 */
export async function writeCardPositionsInTx({
  db: tx,
  positions,
}: NeedsTx & { positions: CardPositionUpdate[] }): Promise<void> {
  // Size batches for two CASE-updated columns. Assert the row count in each disjoint batch.
  for (const batch of caseUpdateBatches(positions, 2)) {
    const updated = await tx
      .update(cardTable)
      .set(buildPositionCaseWhen(batch))
      .where(
        inArray(
          cardTable.id,
          batch.map(({ cardId }) => cardId),
        ),
      )
      .returning({ id: cardTable.id });
    if (updated.length !== batch.length)
      throw new Error(
        `writeCardPositionsInTx: expected ${batch.length} updates, got ${updated.length}`,
      );
  }
}

type ReassignCardsToPartition = {
  db: DB;
  namespaceId: string;
  cardIds: string[];
  partitionId: string;
};

/** Shared ownership and destination failures from {@link ReassignLayerResult}. */
export type ReassignPartitionResult = BatchResult<"foreign-cards" | "foreign-partition">;

export async function reassignCardsToPartition({
  db,
  namespaceId,
  cardIds,
  partitionId,
}: ReassignCardsToPartition): Promise<ReassignPartitionResult> {
  if (cardIds.length === 0) return { ok: true };

  return withTx(db, async (tx) => {
    // Check the destination first, as in `reassignCardsToLayer`.
    const partition = await tx
      .select({ id: partitionTable.id })
      .from(partitionTable)
      .where(and(eq(partitionTable.id, partitionId), eq(partitionTable.namespaceId, namespaceId)))
      .get();
    if (!partition) return { ok: false, reason: "foreign-partition" };

    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;

    for (const batch of chunked([...new Set(cardIds)], { size: BATCH_MAX }))
      await tx.update(cardTable).set({ partitionId }).where(inArray(cardTable.id, batch));

    return { ok: true };
  });
}
