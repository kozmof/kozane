/**
 * Coordinate transactional writes across tables when placing the operation in a table module
 * would create circular imports.
 *
 * Preserve related data during card deletion, squash, and partition deletion. Keep operations
 * beside their table when dependencies remain one-way.
 */

import { withTx, type DB, type Tx } from "../tx.js";
import {
  addCard,
  newCardStamps,
  reassignPartitionCards,
  reassignLayerCards,
  cardsBelongToNamespace,
  getCardPartitionNames,
  getCardLayerNames,
  reassignCardsToLayerInTx,
  onCanvas,
  type CardStacking,
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
import { releaseCardsInTx } from "./inventory.js";
import {
  NotFoundError,
  DefaultPartitionError,
  DefaultLayerError,
  columnCount,
  type CardBatchResult,
} from "./utils.js";
import { and, eq, gt, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { partitionTable, cardTable, scopeRelTable, taskspaceTable } from "../schema.js";
import type { Card, NeedsPartition, NeedsTaskspace } from "./types.js";
import { BATCH_MAX, chunked, clamp } from "../../lib/constants.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";

type CreateCardFromTaskspace = NeedsTaskspace & NeedsPartition & { content: string; db: DB };
type CreateCardInTaskspaceContext = Omit<CreateCardFromTaskspace, "db"> & { db: Tx };

/**
 * Core logic for creating a card within a taskspace context. Require a transaction so the
 * card insert and scope_rel insert stay atomic. Callers go through `createCardFromTaskspace`.
 */
async function createCardInTaskspaceContext({
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
 * Create a card linked to a taskspace in the given partition. Add it to the taskspace's scope
 * in the same transaction when a scope is assigned. Throw `NotFoundError` if the taskspace
 * is missing or its assigned namespace does not contain the partition.
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
    for (const batch of chunked(uniqueIds, { size: BATCH_MAX }))
      await tx.delete(cardTable).where(inArray(cardTable.id, batch));
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
  | { ok: false; reason: "not-found" | "stored" | "indivisible" | "too-many" }
  | {
      ok: true;
      cards: Card[];
      /** Cards on the source's layer raised to make room for the pieces. */
      stacking: CardStacking[];
    };

/**
 * Replace a card with one card per text segment in a single transaction. Pieces inherit the
 * partition, layer, taskspace, width, and scope memberships and are laid out from the
 * original position.
 *
 * Reject a single segment to avoid replacing a card without changing its text. Reject a stored
 * card, since the pieces are laid out on the canvas around a position the card does not
 * occupy. Remove the source from its glue group and leave the new pieces unglued.
 *
 * The pieces take consecutive zIndex values from the source's. Cards above the source on its
 * layer are raised by the extra count so no piece ties with, or rises past, a card that sat
 * above the source.
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
        inventoryId: cardTable.inventoryId,
      })
      .from(cardTable)
      .innerJoin(partitionTable, inNamespace)
      .where(eq(cardTable.id, cardId))
      .get();
    if (!source) return { ok: false, reason: "not-found" };
    if (source.inventoryId !== null) return { ok: false, reason: "stored" };

    const contents = splitCardContent(source.content);
    if (contents.length < 2) return { ok: false, reason: "indivisible" };
    if (contents.length > BATCH_MAX) return { ok: false, reason: "too-many" };

    // Layout slots only extend right of and below the origin, so cards elsewhere can never
    // block one. Skip reading them rather than scanning the whole board inside the write.
    const occupied = await tx
      .select({ id: cardTable.id, posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(partitionTable, inNamespace)
      .where(
        and(
          gte(cardTable.posX, source.posX),
          gte(cardTable.posY, source.posY),
          // A stored card's position is where it goes back to, not space it takes up now.
          onCanvas,
        ),
      );
    const positions = squashCardPositions(
      // Reuse the original slot for the first piece.
      occupied.filter(({ id }) => id !== cardId),
      contents.length,
      { origin: { posX: source.posX, posY: source.posY }, canvasWidth },
    );

    const extra = contents.length - 1;
    const stacking = await tx
      .update(cardTable)
      .set({ zIndex: sql`${cardTable.zIndex} + ${extra}` })
      .where(and(eq(cardTable.layerId, source.layerId), gt(cardTable.zIndex, source.zIndex)))
      .returning({ cardId: cardTable.id, zIndex: cardTable.zIndex });

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

    return { ok: true, cards, stacking };
  });
}

type MoveCardsToNamespace = {
  db: DB;
  sourceNamespaceId: string;
  targetNamespaceId: string;
  cardIds: string[];
};

type RemapCardsByName = {
  /** Each card paired with its current partition or layer name. */
  current: { cardId: string; name: string }[];
  /** Target partitions or layers matched against `current` by name. */
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
  // Group cards by the resolved target ID in one pass to avoid a second lookup.
  // Index targets once so each card needs one map lookup.
  const targetIdByName = new Map(targets.map(({ id, name }) => [name, id]));
  const groups = new Map<string, string[]>();
  for (const { cardId, name } of current) {
    let targetId = targetIdByName.get(name);
    if (targetId === undefined) {
      targetId = await create(name);
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
 * Refuses if any card does not belong to sourceNamespaceId. Throws when the two namespaces
 * are the same, since the move would otherwise unglue and unstore the cards and change nothing
 * else.
 *
 * Arriving cards are restacked above each destination layer's cards, as a layer move is.
 * A card whose taskspace is placed in another namespace loses that link, because a placed
 * taskspace only originates cards in its own namespace (see
 * {@link createCardFromTaskspace}).
 */
export async function moveCardsToNamespace({
  db,
  sourceNamespaceId,
  targetNamespaceId,
  cardIds: requestedIds,
}: MoveCardsToNamespace): Promise<CardBatchResult> {
  if (sourceNamespaceId === targetNamespaceId)
    throw new Error("Target namespace must differ from source");
  if (requestedIds.length === 0) return { ok: true };
  const cardIds = [...new Set(requestedIds)];
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId: sourceNamespaceId, cardIds });
    if (!owned.ok) return owned;

    const cardPartitions = await getCardPartitionNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardPartitions.map(({ cardId, partitionName }) => ({ cardId, name: partitionName })),
      targets: await getAllPartitions({ db: tx, namespaceId: targetNamespaceId }),
      create: (name) => addPartition({ db: tx, namespaceId: targetNamespaceId, name }),
      assign: async (partitionId, ids) => {
        for (const batch of chunked(ids, { size: BATCH_MAX }))
          await tx.update(cardTable).set({ partitionId }).where(inArray(cardTable.id, batch));
      },
    });

    const cardLayers = await getCardLayerNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardLayers.map(({ cardId, layerName }) => ({ cardId, name: layerName })),
      targets: await getAllLayers({ db: tx, namespaceId: targetNamespaceId }),
      create: async (name) => (await addLayer({ db: tx, namespaceId: targetNamespaceId, name })).id,
      // Partitions were remapped above, so the cards already belong to the target namespace
      // and the layer move's ownership check holds.
      assign: async (layerId, ids) => {
        const moved = await reassignCardsToLayerInTx({
          db: tx,
          namespaceId: targetNamespaceId,
          cardIds: ids,
          layerId,
        });
        if (!moved.ok) throw new Error(`moveCardsToNamespace: layer move refused: ${moved.reason}`);
      },
    });

    const foreignTaskspaces = tx
      .select({ id: taskspaceTable.id })
      .from(taskspaceTable)
      .where(
        and(
          isNotNull(taskspaceTable.namespaceId),
          ne(taskspaceTable.namespaceId, targetNamespaceId),
        ),
      );
    for (const batch of chunked(cardIds, { size: BATCH_MAX }))
      await tx
        .update(cardTable)
        .set({ taskspaceId: null })
        .where(
          and(inArray(cardTable.id, batch), inArray(cardTable.taskspaceId, foreignTaskspaces)),
        );

    // Moving a card to another namespace removes it from its glue group.
    await unglueCardsInTx({ db: tx, cardIds });

    // Inventories belong to one namespace, so a stored card arrives on the target canvas at
    // the position it had before it was stored.
    await releaseCardsInTx({ db: tx, cardIds });

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
