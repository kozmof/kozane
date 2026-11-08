import { partitionTable, cardTable } from "../schema.js";
import { and, asc, count, eq } from "drizzle-orm";
import type {
  NeedsReader,
  ReadsNamespace,
  NeedsTx,
  NeedsNamespace,
  NeedsNamespacePartition,
  Partition,
} from "../database-types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

/**
 * List partitions by ID, which follows creation order for UUIDv7 IDs. Palette assignment
 * depends on this order, so adding a partition does not shift existing colors as name
 * ordering would.
 */
export async function getAllPartitions({ db, namespaceId }: ReadsNamespace): Promise<Partition[]> {
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
export async function getPartitionCardCounts({ db }: NeedsReader): Promise<PartitionCardCount[]> {
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
  // Check namespace ownership even though the partition ID is unique.
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
}: ReadsNamespace): Promise<Partition | undefined> {
  return db
    .select()
    .from(partitionTable)
    .where(and(eq(partitionTable.namespaceId, namespaceId), eq(partitionTable.isDefault, true)))
    .get();
}

type DeletePartitionCascading = NeedsTx & { namespaceId: string; partitionId: string };

/**
 * Delete a partition and, through the foreign-key cascade, every card still in it. Move the
 * cards off first in the same transaction, as `deletePartitionWithReassign` in `composite.ts`
 * does. The name and the transaction requirement keep this from being called as a plain
 * delete.
 */
export async function deletePartitionCascadingInTx({
  db,
  namespaceId,
  partitionId,
}: DeletePartitionCascading): Promise<void> {
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
