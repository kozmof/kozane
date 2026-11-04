/** Deleting a partition or layer after moving its cards to the default one. */
import { withTx, type DB } from "../../database.js";
import { reassignPartitionCards, reassignCardsToLayerInTx, type CardStacking } from "../card.js";
import { deletePartitionCascadingInTx, getPartition, getDefaultPartition } from "../partition.js";
import { deleteLayerCascadingInTx, getLayer, getDefaultLayer } from "../layer.js";
import { NotFoundError, DefaultPartitionError, DefaultLayerError } from "../utils.js";
import { eq } from "drizzle-orm";
import { cardTable } from "../../schema.js";

type DeletePartitionWithReassign = { db: DB; namespaceId: string; partitionId: string };

/**
 * Deletes a non-default partition and reassigns its cards to the namespace's default
 * partition, atomically. Throws NotFoundError if the partition doesn't exist.
 */
export async function deletePartitionWithReassign({
  db,
  namespaceId,
  partitionId,
}: DeletePartitionWithReassign): Promise<{ defaultPartitionId: string }> {
  return withTx(db, async (tx) => {
    const partition = await getPartition({ db: tx, namespaceId, partitionId });
    if (!partition)
      throw new NotFoundError(`Partition namespaceId=${namespaceId} partitionId=${partitionId}`);
    if (partition.isDefault) throw new DefaultPartitionError();

    const defaultPartition = await getDefaultPartition({ db: tx, namespaceId });
    if (!defaultPartition) throw new Error("No default partition found for this namespace");

    await reassignPartitionCards({
      db: tx,
      namespaceId,
      fromPartitionId: partitionId,
      toPartitionId: defaultPartition.id,
    });
    await deletePartitionCascadingInTx({ db: tx, namespaceId, partitionId });

    return { defaultPartitionId: defaultPartition.id };
  });
}

type DeleteLayerWithReassign = { db: DB; namespaceId: string; layerId: string };

/**
 * Deletes a non-default layer and moves its cards to the namespace's default layer,
 * atomically. Without the reassign, deleting a layer would cascade its cards away.
 * Throws NotFoundError if the layer doesn't exist, DefaultLayerError for the default one.
 *
 * The moved cards are restacked above the default layer's cards, keeping their relative
 * order, as any other layer move does. Keeping their old zIndex values would interleave them
 * with the default layer's cards. Returns the new values so the board can apply them.
 */
export async function deleteLayerWithReassign({
  db,
  namespaceId,
  layerId,
}: DeleteLayerWithReassign): Promise<{ defaultLayerId: string; stacking: CardStacking[] }> {
  return withTx(db, async (tx) => {
    const layer = await getLayer({ db: tx, namespaceId, layerId });
    if (!layer) throw new NotFoundError(`Layer namespaceId=${namespaceId} layerId=${layerId}`);
    if (layer.isDefault) throw new DefaultLayerError();

    const defaultLayer = await getDefaultLayer({ db: tx, namespaceId });
    if (!defaultLayer) throw new Error("No default layer found for this namespace");

    const cardIds = (
      await tx.select({ id: cardTable.id }).from(cardTable).where(eq(cardTable.layerId, layerId))
    ).map(({ id }) => id);
    const moved = await reassignCardsToLayerInTx({
      db: tx,
      namespaceId,
      cardIds,
      layerId: defaultLayer.id,
    });
    // Both layers and every card on them belong to this namespace, so a refusal is a bug.
    if (!moved.ok) throw new Error(`reassignCardsToLayerInTx refused: ${moved.reason}`);
    await deleteLayerCascadingInTx({ db: tx, namespaceId, layerId });

    return { defaultLayerId: defaultLayer.id, stacking: moved.stacking };
  });
}
