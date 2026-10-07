import { partitionTable, cardTable } from "../schema.js";
import { and, asc, count, eq } from "drizzle-orm";
import type { NeedsDB, NeedsNamespace, NeedsNamespacePartition, Partition } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

/**
 * List partitions by ID, which follows creation order for UUIDv7 IDs. Palette assignment
 * depends on this order, so adding a partition does not shift existing colors as name
 * ordering would.
 */
export async function getAllPartitions({ db, namespaceId }: NeedsNamespace): Promise<Partition[]> {
  return db
    .select()
    .from(partitionTable)
    .where(eq(partitionTable.namespaceId, namespaceId))
    .orderBy(asc(partitionTable.id));
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
 * Count cards in every partition for the workspace map.
 *
 * Use a left join to include empty partitions, and count `card.id` so an empty partition has
 * zero cards. Group in one workspace-wide query instead of querying each namespace
 * separately.
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
