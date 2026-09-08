import { partitionTable, cardTable } from "../schema.js";
import { and, count, eq } from "drizzle-orm";
import type { NeedsDB, NeedsNamespace, NeedsNamespacePartition, Partition } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

export async function getAllPartitions({ db, namespaceId }: NeedsNamespace): Promise<Partition[]> {
  return db.select().from(partitionTable).where(eq(partitionTable.namespaceId, namespaceId));
}

/** A partition, and how many cards sit in it. See {@link getPartitionCardCounts}. */
export type PartitionCardCount = {
  id: string;
  namespaceId: string;
  name: string;
  isDefault: boolean;
  cards: number;
};

/**
 * Every partition in the workspace, with how many cards it holds.
 *
 * What the map page draws a rectangle from: a partition's area *is* its card count there, so the
 * number is the geometry rather than a label beside it.
 *
 * A `LEFT JOIN`, and that is the whole of what distinguishes this from the obvious query. An
 * inner join answers with the partitions that have a card in them, which on a page whose subject
 * is what a workspace holds is exactly the wrong set: an empty partition would not be drawn
 * small, it would not be drawn at all. `count(card.id)` rather than `count(*)` for the same
 * reason — over a left join the latter counts the one all-null row an empty partition produces
 * and reports it as holding a card.
 *
 * One statement over the workspace rather than one per namespace, the same argument
 * `getScopeNamespaceUsage` makes: the map packs every namespace at once, so the per-namespace shape
 * is a round trip per rectangle, and the grouping SQLite does here is the grouping the caller
 * would otherwise do in JS over every card id in the database. It rides `card_partition`, the
 * index the board's poll already needs.
 */
export async function getPartitionCardCounts({ db }: NeedsDB): Promise<PartitionCardCount[]> {
  return db
    .select({
      id: partitionTable.id,
      namespaceId: partitionTable.namespaceId,
      name: partitionTable.name,
      isDefault: partitionTable.isDefault,
      cards: count(cardTable.id),
    })
    .from(partitionTable)
    .leftJoin(cardTable, eq(cardTable.partitionId, partitionTable.id))
    .groupBy(partitionTable.id);
}

type GetPartition = NeedsNamespacePartition;
export async function getPartition({
  db,
  namespaceId,
  partitionId,
}: GetPartition): Promise<Partition | undefined> {
  // partitionId alone would uniquely identify the row (UUID), but namespaceId is checked too as a
  // defence-in-depth access boundary so callers cannot reach across namespace lines via a bare ID.
  return db
    .select()
    .from(partitionTable)
    .where(and(eq(partitionTable.namespaceId, namespaceId), eq(partitionTable.id, partitionId)))
    .get();
}

type AddPartition = NeedsNamespace & { name: string; isDefault?: boolean };
export async function addPartition({
  db,
  namespaceId,
  name,
  isDefault = false,
}: AddPartition): Promise<string> {
  assertNameWithinLimit(name, "Partition name");
  const [row] = await db
    .insert(partitionTable)
    .values({ namespaceId, name, isDefault })
    .returning({ id: partitionTable.id });
  return row.id;
}

export async function getDefaultPartition({
  db,
  namespaceId,
}: NeedsNamespace): Promise<Partition | undefined> {
  return db
    .select()
    .from(partitionTable)
    .where(and(eq(partitionTable.namespaceId, namespaceId), eq(partitionTable.isDefault, true)))
    .get();
}

type DeletePartition = NeedsNamespacePartition;
export async function deletePartition({
  db,
  namespaceId,
  partitionId,
}: DeletePartition): Promise<void> {
  const deleted = await db
    .delete(partitionTable)
    .where(and(eq(partitionTable.namespaceId, namespaceId), eq(partitionTable.id, partitionId)))
    .returning({ id: partitionTable.id });
  assertFound(deleted, `Partition namespaceId=${namespaceId} partitionId=${partitionId}`);
}

type UpdatePartitionName = NeedsNamespacePartition & { name: string };
export async function updatePartitionName({
  db,
  namespaceId,
  partitionId,
  name,
}: UpdatePartitionName): Promise<void> {
  assertNameWithinLimit(name, "Partition name");
  const updated = await db
    .update(partitionTable)
    .set({ name })
    .where(and(eq(partitionTable.namespaceId, namespaceId), eq(partitionTable.id, partitionId)))
    .returning({ id: partitionTable.id });
  assertFound(updated, `Partition namespaceId=${namespaceId} partitionId=${partitionId}`);
}
