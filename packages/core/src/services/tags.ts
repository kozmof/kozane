import type { TagHit, TagScanTruncation } from "../../../../src/lib/types.js";
import { getAllNamespaces } from "../../../../src/db/api/namespace.js";
import { getAllPartitions } from "../../../../src/db/api/partition.js";
import { getCardPartitionNames } from "../../../../src/db/api/card.js";
import { applyPalette } from "../../../../src/lib/palette.js";
import type { AnyDB } from "../database.js";
import type { ServiceContext } from "./context.js";
import { getCardTagHits, type CardTagHits } from "../../../../src/db/api/tag.js";
export function get(db: AnyDB, _context: ServiceContext, namespaceId?: string) {
  return getCardTagHits({ db, namespaceId });
}

async function partitionsForNamespaces(
  db: AnyDB,
  namespaceIds: string[],
): Promise<Record<string, { name: string; dot: string }>> {
  // Load independent namespace palettes concurrently.
  const palettes = await Promise.all(
    namespaceIds.map(async (namespaceId) =>
      applyPalette(await getAllPartitions({ db, namespaceId })),
    ),
  );

  const byPartition: Record<string, { name: string; dot: string }> = {};
  for (const partitions of palettes) {
    for (const partition of partitions)
      byPartition[partition.id] = { name: partition.name, dot: partition.dot };
  }
  return byPartition;
}

export async function displayMetadata(
  db: AnyDB,
  _context: ServiceContext,
  cardIds: string[],
  namespaceIds: string[],
) {
  const [cardPartitions, partitions] = await Promise.all([
    getCardPartitionNames({ db, cardIds }),
    partitionsForNamespaces(db, namespaceIds),
  ]);
  return { cardPartitions, partitions };
}

export type TagIndexTruncation = {
  taskspaceId: string;
  reasons: TagScanTruncation[];
  /** Sample taskspace-relative paths for scan failures. Empty when no path applies.
   *  See `TaskspaceTagScan.paths`. */
  paths: string[];
};

/**
 * Name and namespace for a scanned taskspace. Keep them together because readers use both to
 * label file hits and link to boards. A null namespace identifies an unplaced taskspace shown
 * on every board.
 */
export type TagIndexTaskspace = { name: string; namespaceId: string | null };

/** Scanned taskspace metadata keyed by ID, with optional lookup values. */
export type TagIndexTaskspaces = Record<string, TagIndexTaskspace | undefined>;

export type TagIndex = {
  /** Card and file hits share one list. `hit.source.kind` identifies their source. */
  hits: TagHit[];
  /** Cached partition/namespace/change-day dimensions for every card carrying a hit. */
  cardData: CardTagHits["cardData"];
  /** Which namespace each card carrying a hit belongs to. See `CardTagHits`. */
  cardNamespaces: Record<string, string | undefined>;
  /**
   * Metadata for taskspaces considered by this gather. Return an empty map when file scanning
   * is disabled, and allow missing lookups in page-filtered or older data.
   *
   * Reuse gathered metadata so readers do not fetch or publish unrelated taskspace names.
   */
  taskspaces: TagIndexTaskspaces;
  truncated: TagIndexTruncation[];
  /**
   * IDs of taskspaces whose root directories could not be opened. Keep these separate from
   * partial scans so readers can suggest checking or cleaning up the records. Resolve names
   * through {@link TagIndex.taskspaces}.
   */
  missing: string[];
  /**
   * Whether card scanning stopped at {@link TAG_CARD_HITS_MAX}. If true, the hits contain
   * only part of the workspace's card tags. Display this alongside the per-taskspace notices
   * in {@link TagIndex.truncated}.
   */
  cardsTruncated: boolean;
};

export async function assembleViewData(db: AnyDB, context: ServiceContext, index: TagIndex) {
  const cardIds = [
    ...new Set(
      index.hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : [])),
    ),
  ];
  const namespaceIds = [
    ...new Set(
      cardIds.flatMap((id) => (index.cardNamespaces[id] ? [index.cardNamespaces[id]!] : [])),
    ),
  ];
  const metadata = await displayMetadata(db, context, cardIds, namespaceIds);
  return { index, namespaces: await getAllNamespaces({ db }), ...metadata };
}
export async function view(db: AnyDB, context: ServiceContext, namespaceId?: string) {
  const cards = await get(db, context, namespaceId);
  const index: TagIndex = {
    hits: cards.hits,
    cardData: cards.cardData,
    cardNamespaces: cards.cardNamespaces,
    taskspaces: {},
    truncated: [],
    missing: [],
    cardsTruncated: cards.truncated,
  };
  return assembleViewData(db, context, index);
}
export type TagsViewData = Awaited<ReturnType<typeof view>>;
