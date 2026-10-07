/**
 * Coordinate transactional writes across tables when placing the operation in a table module
 * would create circular imports.
 *
 * Preserve related data during card deletion, squash, and partition deletion. Keep operations
 * beside their table when dependencies remain one-way.
 */

import { withTx, type DB } from "../tx.js";
import {
  addCard,
  newCardStamps,
  reassignPartitionCards,
  reassignLayerCards,
  cardsBelongToNamespace,
  getCardPartitionNames,
  getCardLayerNames,
} from "./card.js";
import {
  deletePartition,
  getPartition,
  getDefaultPartition,
  getAllPartitions,
  addPartition,
} from "./partition.js";
import { deleteLayer, getLayer, getDefaultLayer, getAllLayers, addLayer } from "./layer.js";
import { addScopeRel, getScopeRelsByCards } from "./scope-rel.js";
import { getTaskspace } from "./taskspace.js";
import { unglueCardsInTx } from "./glue.js";
import {
  NotFoundError,
  DefaultPartitionError,
  DefaultLayerError,
  columnCount,
  type CardBatchResult,
} from "./utils.js";
import { and, eq, inArray } from "drizzle-orm";
import { partitionTable, cardTable, scopeRelTable } from "../schema.js";
import type { Card, NeedsPartition, NeedsTaskspace } from "./types.js";
import { BATCH_MAX, chunked, clamp } from "../../lib/constants.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";

type CreateCardInTaskspaceContext = NeedsTaskspace & NeedsPartition & { content: string };
type CreateCardFromTaskspace = CreateCardInTaskspaceContext & { db: DB };

/**
 * Core logic for creating a card within a taskspace context.
 * Exported separately so it can be tested without a transaction.
 * Production callers should use `createCardFromTaskspace`, which wraps
 * this in a transaction to keep the card insert and scope_rel insert atomic.
 */
export async function createCardInTaskspaceContext({
  db,
  taskspaceId,
  partitionId,
  content,
}: CreateCardInTaskspaceContext): Promise<string> {
  const taskspace = await getTaskspace({ db, taskspaceId });
  if (!taskspace) throw new NotFoundError(`Taskspace taskspaceId=${taskspaceId}`);
  // A placed taskspace can create cards only in its namespace. An unplaced taskspace appears
  // on every board and can use any partition.
  if (
    taskspace.namespaceId &&
    !(await getPartition({ db, namespaceId: taskspace.namespaceId, partitionId }))
  ) {
    throw new NotFoundError(
      `Partition partitionId=${partitionId} in namespace namespaceId=${taskspace.namespaceId}`,
    );
  }
  const cardId = await addCard({ db, partitionId, content, taskspaceId });
  if (taskspace.scopeId) {
    await addScopeRel({ db, scopeId: taskspace.scopeId, cardId });
  }
  return cardId;
}

/**
 * Creates a card in the given partition within a taskspace context.
 * If the taskspace is still attached to a scope, the new card is
 * simultaneously registered in scope_rel (auto-add, 7-1), making the
 * "originated" and "gathered" relationships consistent from creation time.
 * Throws NotFoundError when taskspaceId does not exist.
 */
export async function createCardFromTaskspace({
  db,
  taskspaceId,
  partitionId,
  content,
}: CreateCardFromTaskspace): Promise<string> {
  return withTx(db, (tx) =>
    createCardInTaskspaceContext({ db: tx, taskspaceId, partitionId, content }),
  );
}

type DeleteNamespaceCards = { db: DB; namespaceId: string; cardIds: string[] };

/**
 * Delete cards only if they all belong to the namespace. Dissolve glue groups left with fewer
 * than two cards.
 *
 * Card deletion cascades through `glue_rel` without running the glue helpers, so explicitly
 * clean up the affected groups.
 */
export async function deleteNamespaceCards({
  db,
  namespaceId,
  cardIds,
}: DeleteNamespaceCards): Promise<CardBatchResult> {
  if (cardIds.length === 0) return { ok: true };
  const uniqueIds = [...new Set(cardIds)];
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds: uniqueIds });
    if (!owned.ok) return owned;
    await unglueCardsInTx({ db: tx, cardIds: uniqueIds });
    await tx.delete(cardTable).where(inArray(cardTable.id, uniqueIds));
    return { ok: true };
  });
}

type SquashNamespaceCard = {
  db: DB;
  namespaceId: string;
  cardId: string;
  canvasWidth: number;
  canvasHeight: number;
};

export type SquashCardResult =
  | { ok: false; reason: "not-found" | "indivisible" | "too-many" }
  | { ok: true; cards: Card[] };

/**
 * Replace a card with one card per text segment in a single transaction. Pieces inherit the
 * partition, layer, taskspace, width, and scope memberships and are laid out from the
 * original position.
 *
 * Reject a single segment to avoid replacing a card without changing its text. Remove the
 * source from its glue group and leave the new pieces unglued.
 */
export async function squashNamespaceCard({
  db,
  namespaceId,
  cardId,
  canvasWidth,
  canvasHeight,
}: SquashNamespaceCard): Promise<SquashCardResult> {
  return withTx(db, async (tx) => {
    const inNamespace = and(
      eq(cardTable.partitionId, partitionTable.id),
      eq(partitionTable.namespaceId, namespaceId),
    );
    const source = await tx
      .select({
        id: cardTable.id,
        partitionId: cardTable.partitionId,
        layerId: cardTable.layerId,
        taskspaceId: cardTable.taskspaceId,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
        zIndex: cardTable.zIndex,
        width: cardTable.width,
      })
      .from(cardTable)
      .innerJoin(partitionTable, inNamespace)
      .where(eq(cardTable.id, cardId))
      .get();
    if (!source) return { ok: false, reason: "not-found" };

    const contents = splitCardContent(source.content);
    if (contents.length < 2) return { ok: false, reason: "indivisible" };
    if (contents.length > BATCH_MAX) return { ok: false, reason: "too-many" };

    const occupied = await tx
      .select({ id: cardTable.id, posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(partitionTable, inNamespace);
    const positions = squashCardPositions(
      // Reuse the original slot for the first piece.
      occupied.filter(({ id }) => id !== cardId),
      contents.length,
      { origin: { posX: source.posX, posY: source.posY }, canvasWidth },
    );

    const cards: Card[] = [];
    // Use one timestamp for every piece, as `addCards` does for CLI squash. See {@link
    // newCardStamps}.
    const stamps = newCardStamps();
    const rows = contents.map((content, index) => ({
      ...stamps,
      partitionId: source.partitionId,
      layerId: source.layerId,
      taskspaceId: source.taskspaceId,
      content,
      // The layout runs off the board once the origin is near enough to an edge, and a
      // stored position outside it is one the viewport can never reach.
      posX: clamp(positions[index].posX, 0, canvasWidth),
      posY: clamp(positions[index].posY, 0, canvasHeight),
      // Above whatever the source sat above, and in the order the text reads.
      zIndex: source.zIndex + index,
      width: source.width,
    }));
    for (const batch of chunked(rows, { columnsPerRow: columnCount(cardTable) }))
      cards.push(...(await tx.insert(cardTable).values(batch).returning()));

    // Pieces inherit the source card's scopes.
    const scopeIds = (await getScopeRelsByCards({ db: tx, cardIds: [cardId] })).map(
      ({ scopeId }) => scopeId,
    );
    const scopeRels = scopeIds.flatMap((scopeId) =>
      cards.map(({ id }) => ({ scopeId, cardId: id })),
    );
    for (const batch of chunked(scopeRels))
      await tx.insert(scopeRelTable).values(batch).onConflictDoNothing();

    await unglueCardsInTx({ db: tx, cardIds: [cardId] });
    await tx.delete(cardTable).where(eq(cardTable.id, cardId));

    return { ok: true, cards };
  });
}

type MoveCardsToNamespace = {
  db: DB;
  sourceNamespaceId: string;
  targetNamespaceId: string;
  cardIds: string[];
};

type RemapCardsByName = {
  /** Each card paired with the name of the thing it currently belongs to. */
  current: { cardId: string; name: string }[];
  /** Candidates in the target namespace, matched against `current` by name. */
  targets: { id: string; name: string }[];
  create: (name: string) => Promise<string>;
  assign: (targetId: string, cardIds: string[]) => Promise<void>;
};

/**
 * Resolve a card's partition or layer by name in the target namespace, creating it if needed.
 * Both ownership IDs must change when moving across namespaces.
 */
async function remapCardsByName({
  current,
  targets,
  create,
  assign,
}: RemapCardsByName): Promise<void> {
  // Resolved and grouped in one pass, so the id a card is filed under is the one just
  // looked up rather than a second lookup that has to be asserted non-empty.
  const targetIdByName = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const { cardId, name } of current) {
    let targetId = targetIdByName.get(name);
    if (targetId === undefined) {
      targetId = targets.find((target) => target.name === name)?.id ?? (await create(name));
      targetIdByName.set(name, targetId);
    }
    const group = groups.get(targetId) ?? [];
    group.push(cardId);
    groups.set(targetId, group);
  }

  for (const [targetId, ids] of groups) await assign(targetId, ids);
}

/**
 * Moves cards from one namespace to another, preserving partition and layer names.
 * For each unique source name, a matching partition/layer is found in the target
 * namespace or created if absent. All updates are atomic.
 * Refuses if any card does not belong to sourceNamespaceId.
 */
export async function moveCardsToNamespace({
  db,
  sourceNamespaceId,
  targetNamespaceId,
  cardIds,
}: MoveCardsToNamespace): Promise<CardBatchResult> {
  if (cardIds.length === 0) return { ok: true };
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId: sourceNamespaceId, cardIds });
    if (!owned.ok) return owned;

    const cardPartitions = await getCardPartitionNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardPartitions.map(({ cardId, partitionName }) => ({ cardId, name: partitionName })),
      targets: await getAllPartitions({ db: tx, namespaceId: targetNamespaceId }),
      create: (name) => addPartition({ db: tx, namespaceId: targetNamespaceId, name }),
      assign: async (partitionId, ids) => {
        await tx.update(cardTable).set({ partitionId }).where(inArray(cardTable.id, ids));
      },
    });

    const cardLayers = await getCardLayerNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardLayers.map(({ cardId, layerName }) => ({ cardId, name: layerName })),
      targets: await getAllLayers({ db: tx, namespaceId: targetNamespaceId }),
      create: async (name) => (await addLayer({ db: tx, namespaceId: targetNamespaceId, name })).id,
      assign: async (layerId, ids) => {
        await tx.update(cardTable).set({ layerId }).where(inArray(cardTable.id, ids));
      },
    });

    // Moving a card to another namespace removes it from its glue group.
    await unglueCardsInTx({ db: tx, cardIds });

    return { ok: true };
  });
}

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
      fromPartitionId: partitionId,
      toPartitionId: defaultPartition.id,
    });
    await deletePartition({ db: tx, namespaceId, partitionId });

    return { defaultPartitionId: defaultPartition.id };
  });
}

type DeleteLayerWithReassign = { db: DB; namespaceId: string; layerId: string };

/**
 * Deletes a non-default layer and moves its cards to the namespace's default layer,
 * atomically. Without the reassign, deleting a layer would cascade its cards away.
 * Throws NotFoundError if the layer doesn't exist, DefaultLayerError for the default one.
 */
export async function deleteLayerWithReassign({
  db,
  namespaceId,
  layerId,
}: DeleteLayerWithReassign): Promise<{ defaultLayerId: string }> {
  return withTx(db, async (tx) => {
    const layer = await getLayer({ db: tx, namespaceId, layerId });
    if (!layer) throw new NotFoundError(`Layer namespaceId=${namespaceId} layerId=${layerId}`);
    if (layer.isDefault) throw new DefaultLayerError();

    const defaultLayer = await getDefaultLayer({ db: tx, namespaceId });
    if (!defaultLayer) throw new Error("No default layer found for this namespace");

    await reassignLayerCards({ db: tx, fromLayerId: layerId, toLayerId: defaultLayer.id });
    await deleteLayer({ db: tx, namespaceId, layerId });

    return { defaultLayerId: defaultLayer.id };
  });
}
