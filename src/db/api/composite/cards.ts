/** Card creation from a taskspace, and card deletion with glue cleanup. */
import { withTx, type DB, type Tx } from "../../tx.js";
import { addCardInTx, cardsBelongToNamespace } from "../card.js";
import { getPartition } from "../partition.js";
import { addScopeRel } from "../scope-rel.js";
import { getTaskspace } from "../taskspace.js";
import { unglueCardsInTx } from "../glue.js";
import { NotFoundError, type CardBatchResult } from "../utils.js";
import { inArray } from "drizzle-orm";
import { cardTable } from "../../schema.js";
import type { NeedsPartition, NeedsTaskspace } from "../types.js";
import { BATCH_MAX, chunked } from "../../../lib/constants.js";

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
  const cardId = await addCardInTx({ db, partitionId, content, taskspaceId });
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
