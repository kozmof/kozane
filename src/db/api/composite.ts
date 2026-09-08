/**
 * The writes that span more than one of the sibling modules and have to land whole.
 *
 * That is the entire rule for what belongs here, and it is worth writing down because the
 * name says how the module is built rather than what it is for — every function in it is
 * composed of others, which describes half of `db/api` and is not why these eight sit
 * together. What they share is an invariant no single-table module can hold: deleting a card
 * must dissolve a glue group the deletion would leave with one member; squashing one must
 * insert the pieces, carry the scope memberships over, and remove the original or none of
 * it; deleting a partition must move its cards before the cascade takes them.
 *
 * So each of these opens the transaction, and the modules it calls into take `AnyDB` and run
 * inside it. The alternative — a card function reaching into glue, a partition function reaching
 * into card — is the import cycle this module exists instead of.
 *
 * A function belongs here when leaving it out would let a partial write be observed. A
 * function that merely calls two others in sequence does not: it belongs beside whichever
 * table it is about.
 */

import { withTx, type DB, type AnyDB } from "../tx.js";
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
import type { Card } from "./types.js";
import { BATCH_MAX, chunked, clamp } from "../../lib/constants.js";
import { splitCardContent, squashCardPositions } from "../../lib/squash.js";

type CreateCardFromTaskspace = {
  db: DB;
  taskspaceId: string;
  partitionId: string;
  content: string;
};

type CreateCardInTaskspaceContext = {
  db: AnyDB;
  taskspaceId: string;
  partitionId: string;
  content: string;
};

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
 * Deletes cards after verifying every one belongs to namespaceId, dissolving any glue
 * group the removal would leave degenerate. Refuses if any card is not owned.
 *
 * The unglue step is not optional: deleting a card cascades its glue_rel row away
 * without going through glue.ts, which would strand the surviving partner of a
 * two-card group in a group of one — a card the UI still offers to "unglue".
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
 * Replaces a card with one card per segment of its text, in the manner of
 * `kozane card squash`: the pieces inherit its partition, layer, taskspace, width, and scope
 * memberships, are laid out from where it sat, and the card itself is removed. All in one
 * transaction, so a failure leaves the original whole rather than half of it on the board.
 *
 * Refuses a card whose text yields a single segment — squashing it would delete and
 * recreate the same card under a new id, breaking any reference to the old one for nothing.
 *
 * The source leaves its glue group on the way out, for the reason `deleteNamespaceCards`
 * gives. The pieces start unglued: they are one card's worth of text, not a group someone
 * arranged.
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
      // Not the source's own slot: it is about to be deleted, so the first piece takes the
      // place the card the user was looking at had.
      occupied.filter(({ id }) => id !== cardId),
      contents.length,
      { origin: { posX: source.posX, posY: source.posY }, canvasWidth },
    );

    const cards: Card[] = [];
    // One moment for every piece, so the listing cannot separate cards the same squash
    // produced. See {@link newCardStamps}; `kozane card squash` gets the same through
    // `addCards`.
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

    // What the source was gathered into, the pieces are gathered into: a scope is a
    // working set, and splitting a card is not a decision to leave one.
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
 * Re-points cards at the same-named row in another namespace, creating it when the target
 * has none. Both of a card's owners — its partition and its layer — are per-namespace ids that
 * cannot survive a move, and both are preserved this way.
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

    // Cards moved cross-namespace must leave their glue groups: a glue group
    // spanning two namespaces is never visible in the UI and leaves stale rows.
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
