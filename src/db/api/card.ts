import { partitionTable, cardTable, layerTable } from "../schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type {
  NeedsDB,
  NeedsPartition,
  NeedsNamespace,
  NeedsNamespaceCards,
  Card,
} from "./types.js";
import type { CardData } from "../../lib/types.js";
import { BATCH_MAX, WARP_HINT_MAX_CHARS, chunked } from "../../lib/constants.js";
import { compareIds } from "../../lib/order.js";
import {
  assertFound,
  columnCount,
  readByIds,
  type BatchResult,
  type CardBatchResult,
} from "./utils.js";
import { withTx, type DB, type Tx } from "../tx.js";

// ── Simple operations (no ownership check) ────────────────────────────────────

export async function cardsInNamespace({
  db,
  namespaceId,
  cardIds,
}: NeedsNamespaceCards): Promise<string[]> {
  const rows = await readByIds(cardIds, (batch) =>
    db
      .select({ id: cardTable.id })
      .from(cardTable)
      .innerJoin(
        partitionTable,
        and(
          eq(cardTable.partitionId, partitionTable.id),
          eq(partitionTable.namespaceId, namespaceId),
        ),
      )
      .where(inArray(cardTable.id, batch)),
  );
  return rows.map((r) => r.id);
}

/**
 * Verify that every distinct card ID belongs to the namespace. Deduplicate before comparing
 * counts because an `IN` query returns each row only once.
 */
export async function cardsBelongToNamespace({
  db,
  namespaceId,
  cardIds,
}: NeedsNamespaceCards): Promise<CardBatchResult> {
  const wanted = [...new Set(cardIds)];
  const owned = await cardsInNamespace({ db, namespaceId, cardIds: wanted });
  return owned.length === wanted.length ? { ok: true } : { ok: false, reason: "foreign-cards" };
}

export async function getAllCards({ db, partitionId }: NeedsPartition): Promise<Card[]> {
  return db.select().from(cardTable).where(eq(cardTable.partitionId, partitionId));
}

/**
 * Read only the IDs of a namespace's cards for callers building short-ID maps. Use one query
 * across its partitions.
 */
export async function getNamespaceCardIds({ db, namespaceId }: NeedsNamespace): Promise<string[]> {
  const rows = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
    .where(eq(partitionTable.namespaceId, namespaceId));
  return rows.map(({ id }) => id);
}

type GetCardsByPartitions = NeedsDB & { partitionIds: string[] };
export async function getCardsByPartitions({
  db,
  partitionIds,
}: GetCardsByPartitions): Promise<Card[]> {
  if (partitionIds.length === 0) return [];
  return db.select().from(cardTable).where(inArray(cardTable.partitionId, partitionIds));
}

/**
 * Columns sent to the browser in a card snapshot. The `satisfies` check keeps this selection
 * aligned with `CardData`, and `readCard` validates the same fields.
 *
 * Select columns explicitly so adding a schema field does not automatically expose it in page
 * loads, polling responses, or static exports.
 */
const CARD_DATA_SELECTION = {
  id: cardTable.id,
  content: cardTable.content,
  partitionId: cardTable.partitionId,
  layerId: cardTable.layerId,
  posX: cardTable.posX,
  posY: cardTable.posY,
  taskspaceId: cardTable.taskspaceId,
  zIndex: cardTable.zIndex,
  width: cardTable.width,
} satisfies Record<keyof CardData, AnyColumn>;

/**
 * Read the card fields used by the board. Page loads and snapshot polls share this selection
 * through `loadNamespaceSnapshot`.
 */
export async function getCardDataByPartitions({
  db,
  partitionIds,
}: GetCardsByPartitions): Promise<CardData[]> {
  if (partitionIds.length === 0) return [];
  return db
    .select(CARD_DATA_SELECTION)
    .from(cardTable)
    .where(inArray(cardTable.partitionId, partitionIds));
}

export type CardMarker = {
  namespaceId: string;
  posX: number;
  posY: number;
  zIndex: number;
  /** Opening text used to build a card hint. */
  content: string;
  /** Keep the full `contentChars` count for height estimates when returning a content prefix. */
  contentChars: number;
  /**
   * Pinned card width, or null to use `ui.defaultCardWidth`. The hint's distance calculation
   * uses the card's drawn bounds.
   */
  width: number | null;
};
type GetCardMarkers = NeedsDB & { namespaceIds: string[] };

/**
 * Maximum source text read for a warp hint. Keep this bounded while reading the full
 * character count separately to estimate card height.
 *
 * A card whose entire prefix is whitespace provides no hint, even if later text is nonblank.
 */
const HINT_SOURCE_MAX_CHARS = WARP_HINT_MAX_CHARS * 5;

/**
 * Read the card data needed to find a hint near each warp. Limit text per row and exclude
 * blank cards.
 *
 * Keep cards at every position because their estimated height depends on text length. A tall
 * card starting far above a warp can still reach it. Restricting positions would require
 * matching the height model in SQL.
 */
export async function getCardMarkersByNamespaces({
  db,
  namespaceIds,
}: GetCardMarkers): Promise<CardMarker[]> {
  if (namespaceIds.length === 0) return [];
  return db
    .select({
      namespaceId: partitionTable.namespaceId,
      posX: cardTable.posX,
      posY: cardTable.posY,
      zIndex: cardTable.zIndex,
      content: sql<string>`substr(${cardTable.content}, 1, ${HINT_SOURCE_MAX_CHARS})`,
      // `length()` counts characters rather than bytes for text, so this is the same
      // count the opening above is cut by.
      contentChars: sql<number>`length(${cardTable.content})`,
      width: cardTable.width,
    })
    .from(cardTable)
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
    .where(
      and(inArray(partitionTable.namespaceId, namespaceIds), sql`trim(${cardTable.content}) <> ''`),
    );
}

type GetCard = NeedsPartition & { cardId: string };
export async function getCard({ db, partitionId, cardId }: GetCard): Promise<Card | undefined> {
  return db
    .select()
    .from(cardTable)
    .where(and(eq(cardTable.partitionId, partitionId), eq(cardTable.id, cardId)))
    .get();
}

/**
 * The default layer of the namespace the partition belongs to. Every namespace has one
 * (created alongside its default partition, and backfilled by migration 0005), so a
 * caller that does not care about layers still writes a valid `card.layer_id`.
 */
export async function defaultLayerIdForPartition({
  db,
  partitionId,
}: NeedsPartition): Promise<string> {
  const row = await db
    .select({ id: layerTable.id })
    .from(layerTable)
    .innerJoin(partitionTable, eq(partitionTable.namespaceId, layerTable.namespaceId))
    .where(and(eq(partitionTable.id, partitionId), eq(layerTable.isDefault, true)))
    .get();
  if (!row) throw new Error(`No default layer found for partition partitionId=${partitionId}`);
  return row.id;
}

type AddCard = NeedsPartition & {
  content: string;
  layerId?: string;
  taskspaceId?: string;
  posX?: number;
  posY?: number;
  zIndex?: number;
};
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

export async function addCard({
  db,
  partitionId,
  content,
  layerId,
  taskspaceId,
  posX,
  posY,
  zIndex,
}: AddCard): Promise<string> {
  const [row] = await db
    .insert(cardTable)
    .values({
      ...newCardStamps(),
      partitionId,
      layerId: layerId ?? (await defaultLayerIdForPartition({ db, partitionId })),
      content,
      taskspaceId,
      ...(posX !== undefined && { posX }),
      ...(posY !== undefined && { posY }),
      ...(zIndex !== undefined && { zIndex }),
    })
    .returning({ id: cardTable.id });
  return row.id;
}

type AddCards = NeedsPartition & {
  layerId: string;
  cards: { content: string; posX: number; posY: number }[];
};

/**
 * Insert cards into one partition and layer using {@link chunked} statements. Return IDs in
 * input order.
 *
 * Require a resolved `layerId` to avoid a default-layer lookup for each chunk.
 */
export async function addCards({ db, partitionId, layerId, cards }: AddCards): Promise<string[]> {
  if (cards.length === 0) return [];
  // Share one timestamp across all chunks. See {@link newCardStamps}.
  const stamps = newCardStamps();
  const ids: string[] = [];
  for (const batch of chunked(cards, { columnsPerRow: columnCount(cardTable) })) {
    const rows = await db
      .insert(cardTable)
      .values(batch.map((card) => ({ ...stamps, partitionId, layerId, ...card })))
      .returning({ id: cardTable.id });
    ids.push(...rows.map(({ id }) => id));
  }
  return ids;
}

// Delete cards through the composite operation to clean up glue groups without a circular
// import.

type GetCardPartitionNames = NeedsDB & { cardIds: string[] };
/**
 * Find each card's partition using {@link readByIds} to stay within SQLite's parameter
 * budget. Static tag export can request every tagged card at once.
 */
export async function getCardPartitionNames({
  db,
  cardIds,
}: GetCardPartitionNames): Promise<
  { cardId: string; partitionId: string; partitionName: string }[]
> {
  return readByIds(cardIds, (batch) =>
    db
      .select({
        cardId: cardTable.id,
        partitionId: partitionTable.id,
        partitionName: partitionTable.name,
      })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
      .where(inArray(cardTable.id, batch)),
  );
}

export type CardChangeCount = { day: string; partitionId: string; cards: number };

/**
 * Count content changes by day and partition. Creation counts as the first change.
 * Arrangement updates leave `updated_at` unchanged and do not add changes.
 */
export async function getCardChangeCounts({
  db,
  namespaceIds,
}: NeedsDB & { namespaceIds?: string[] }): Promise<CardChangeCount[]> {
  if (namespaceIds?.length === 0) return [];
  const day = sql<string>`strftime('%Y-%m-%d', ${cardTable.updatedAt}, 'unixepoch')`;
  const query = db
    .select({
      day,
      partitionId: cardTable.partitionId,
      cards: sql<number>`count(*)`,
    })
    .from(cardTable)
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
    .groupBy(day, cardTable.partitionId);
  return namespaceIds ? query.where(inArray(partitionTable.namespaceId, namespaceIds)) : query;
}

type GetCardLayerNames = NeedsDB & { cardIds: string[] };
export async function getCardLayerNames({
  db,
  cardIds,
}: GetCardLayerNames): Promise<{ cardId: string; layerId: string; layerName: string }[]> {
  return readByIds(cardIds, (batch) =>
    db
      .select({
        cardId: cardTable.id,
        layerId: layerTable.id,
        layerName: layerTable.name,
      })
      .from(cardTable)
      .innerJoin(layerTable, eq(cardTable.layerId, layerTable.id))
      .where(inArray(cardTable.id, batch)),
  );
}

type ReassignPartitionCards = NeedsDB & { fromPartitionId: string; toPartitionId: string };
export async function reassignPartitionCards({
  db,
  fromPartitionId,
  toPartitionId,
}: ReassignPartitionCards): Promise<void> {
  await db
    .update(cardTable)
    .set({ partitionId: toPartitionId })
    .where(eq(cardTable.partitionId, fromPartitionId));
}

type ReassignLayerCards = NeedsDB & { fromLayerId: string; toLayerId: string };
export async function reassignLayerCards({
  db,
  fromLayerId,
  toLayerId,
}: ReassignLayerCards): Promise<void> {
  await db.update(cardTable).set({ layerId: toLayerId }).where(eq(cardTable.layerId, fromLayerId));
}

type UpdateCard = NeedsDB & {
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
   * Undefined leaves whichever of the two it is on now alone.
   */
  width?: number | null;
};
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
 * The content column is non-null, and `unixepoch()` returns the seconds expected by the
 * timestamp column.
 */
function contentUpdatedAt(content: string): SQL {
  return sql`CASE WHEN ${cardTable.content} <> ${content} THEN unixepoch() ELSE ${cardTable.updatedAt} END`;
}

export async function updateCard({
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
}: UpdateCard): Promise<void> {
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

/**
 * Parameters required per row in a CASE update. Count the ID and value for each column, plus
 * the ID in the WHERE clause, so adding a column reduces the chunk size automatically.
 */
function caseUpdateParamsPerRow(columns: number): number {
  return 2 * columns + 1;
}

/**
 * Chunk CASE statements within the parameter limit. A shared transaction keeps the update
 * atomic.
 */
function caseUpdateBatches<T>(rows: T[], columns: number): T[][] {
  return chunked(rows, { size: BATCH_MAX, columnsPerRow: caseUpdateParamsPerRow(columns) });
}

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

/** Last write wins, so a repeated cardId resolves the same way it would in sequence. */
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

    // Size batches for two CASE-updated columns. Assert the row count in each disjoint batch.
    for (const batch of caseUpdateBatches(unique, 2)) {
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
          `updateNamespaceCardPositions: expected ${batch.length} updates, got ${updated.length}`,
        );
    }

    return { ok: true };
  });
}

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

/** The layer and stacking of each named card, read in batches like every id-list read. */
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
 * The highest and lowest zIndex on a layer, each clamped to 0 so an empty layer starts where
 * a first card would. Asked of SQLite rather than folded over every card's row in JS.
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

  return withTx(db, async (tx) => {
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
    for (const batch of caseUpdateBatches(stacking, 1))
      await tx
        .update(cardTable)
        .set({ layerId, zIndex: buildZIndexCaseWhen(batch) })
        .where(
          inArray(
            cardTable.id,
            batch.map(({ cardId }) => cardId),
          ),
        );

    return { ok: true, stacking };
  });
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

    const stacking: CardStacking[] = [];
    for (const [layerId, group] of byLayer) {
      const { top, bottom } = await layerStackBounds(tx, layerId);

      const ordered = [...group].sort((a, b) => a.zIndex - b.zIndex || compareIds(a.id, b.id));
      if (direction === "front") {
        ordered.forEach((card, index) =>
          stacking.push({ cardId: card.id, zIndex: top + 1 + index }),
        );
      } else {
        // Handed out from the bottom up in the same order, so the card that was already
        // lowest in the group stays lowest rather than landing on top of its own group.
        const n = ordered.length;
        ordered.forEach((card, index) =>
          stacking.push({ cardId: card.id, zIndex: bottom - (n - index) }),
        );
      }
    }

    for (const batch of caseUpdateBatches(stacking, 1))
      await tx
        .update(cardTable)
        .set({ zIndex: buildZIndexCaseWhen(batch) })
        .where(
          inArray(
            cardTable.id,
            batch.map(({ cardId }) => cardId),
          ),
        );

    return { ok: true, stacking };
  });
}

type ReassignCardsToPartition = {
  db: DB;
  namespaceId: string;
  cardIds: string[];
  partitionId: string;
};

/** Refused the two ways {@link ReassignLayerResult} is, for the same reason. */
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
