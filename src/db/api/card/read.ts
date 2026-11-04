/** Card reads: ownership checks, board snapshots, warp hints, and lookups by ID. */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import { cardTable, layerTable, partitionTable } from "../../schema.js";
import type {
  Card,
  NeedsDB,
  NeedsNamespace,
  NeedsNamespaceCards,
  NeedsPartition,
  NeedsReader,
} from "../types.js";
import type { CardData } from "../../../lib/types.js";
import { WARP_HINT_MAX_CHARS } from "../../../lib/constants.js";
import { readByIds, type CardBatchResult } from "../utils.js";
import { onCanvas, withCardInventory } from "./placement.js";

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

type GetCardsByPartitions = NeedsReader & { partitionIds: string[] };
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
} satisfies Record<Exclude<keyof CardData, "inventory">, AnyColumn>;

/**
 * Read the card fields used by the board. Page loads and snapshot polls share this selection
 * through `loadNamespaceSnapshot`.
 */
export async function getCardDataByPartitions({
  db,
  partitionIds,
}: GetCardsByPartitions): Promise<CardData[]> {
  if (partitionIds.length === 0) return [];
  const rows = await db
    .select({
      ...CARD_DATA_SELECTION,
      inventoryId: cardTable.inventoryId,
      inventorySlot: cardTable.inventorySlot,
    })
    .from(cardTable)
    .where(inArray(cardTable.partitionId, partitionIds));
  return rows.map(withCardInventory);
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
type GetCardMarkers = NeedsReader & { namespaceIds: string[] };

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
      and(
        inArray(partitionTable.namespaceId, namespaceIds),
        sql`trim(${cardTable.content}) <> ''`,
        // A stored card is not on the canvas, so it cannot be what a warp lands beside.
        onCanvas,
      ),
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

type GetCardPartitionNames = NeedsReader & { cardIds: string[] };
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
}: NeedsReader & { namespaceIds?: string[] }): Promise<CardChangeCount[]> {
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
