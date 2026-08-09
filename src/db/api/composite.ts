import { withTx, type DB, type AnyDB } from "../tx.js";
import { addCard, reassignBundleCards, cardsInProject, getCardBundleNames } from "./card.js";
import { deleteBundle, getBundle, getDefaultBundle, getAllBundles, addBundle } from "./bundle.js";
import { addScopeRel } from "./scope-rel.js";
import { getTaskspace } from "./taskspace.js";
import { unglueCardsInTx } from "./glue.js";
import { NotFoundError, DefaultBundleError } from "./utils.js";
import { inArray } from "drizzle-orm";
import { cardTable } from "../schema.js";

type CreateCardFromTaskspace = {
  db: DB;
  taskspaceId: string;
  bundleId: string;
  content: string;
};

type CreateCardInTaskspaceContext = {
  db: AnyDB;
  taskspaceId: string;
  bundleId: string;
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
  bundleId,
  content,
}: CreateCardInTaskspaceContext): Promise<string> {
  const taskspace = await getTaskspace({ db, taskspaceId });
  if (!taskspace) throw new NotFoundError(`Taskspace taskspaceId=${taskspaceId}`);
  const cardId = await addCard({ db, bundleId, content, taskspaceId });
  if (taskspace.scopeId) {
    await addScopeRel({ db, scopeId: taskspace.scopeId, cardId });
  }
  return cardId;
}

/**
 * Creates a card in the given bundle within a taskspace context.
 * If the taskspace is still attached to a scope, the new card is
 * simultaneously registered in scope_rel (auto-add, 7-1), making the
 * "originated" and "gathered" relationships consistent from creation time.
 * Throws NotFoundError when taskspaceId does not exist.
 */
export async function createCardFromTaskspace({
  db,
  taskspaceId,
  bundleId,
  content,
}: CreateCardFromTaskspace): Promise<string> {
  return withTx(db, (tx) =>
    createCardInTaskspaceContext({ db: tx, taskspaceId, bundleId, content }),
  );
}

type DeleteProjectCards = { db: DB; projectId: string; cardIds: string[] };

/**
 * Deletes cards after verifying every one belongs to projectId, dissolving any glue
 * group the removal would leave degenerate. Returns false if any card is not owned.
 *
 * The unglue step is not optional: deleting a card cascades its glue_rel row away
 * without going through glue.ts, which would strand the surviving partner of a
 * two-card group in a group of one — a card the UI still offers to "unglue".
 */
export async function deleteProjectCards({
  db,
  projectId,
  cardIds,
}: DeleteProjectCards): Promise<boolean> {
  if (cardIds.length === 0) return true;
  const uniqueIds = [...new Set(cardIds)];
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, uniqueIds);
    if (owned.length !== uniqueIds.length) return false;
    await unglueCardsInTx(tx, uniqueIds);
    await tx.delete(cardTable).where(inArray(cardTable.id, uniqueIds));
    return true;
  });
}

type MoveCardsToProject = {
  db: DB;
  sourceProjectId: string;
  targetProjectId: string;
  cardIds: string[];
};

/**
 * Moves cards from one project to another, preserving bundle names.
 * For each unique source bundle name, a matching bundle is found in the target
 * project or created if absent. All updates are atomic.
 * Returns false if any card does not belong to sourceProjectId.
 */
export async function moveCardsToProject({
  db,
  sourceProjectId,
  targetProjectId,
  cardIds,
}: MoveCardsToProject): Promise<boolean> {
  if (cardIds.length === 0) return true;
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, sourceProjectId, cardIds);
    if (owned.length !== cardIds.length) return false;

    const cardBundles = await getCardBundleNames({ db: tx, cardIds });
    const targetBundles = await getAllBundles({ db: tx, projectId: targetProjectId });

    // Build a map from source bundle name → target bundle id (find or create)
    const bundleNameToTargetId = new Map<string, string>();
    for (const { bundleName } of cardBundles) {
      if (bundleNameToTargetId.has(bundleName)) continue;
      const existing = targetBundles.find((b) => b.name === bundleName);
      if (existing) {
        bundleNameToTargetId.set(bundleName, existing.id);
      } else {
        const newId = await addBundle({ db: tx, projectId: targetProjectId, name: bundleName });
        bundleNameToTargetId.set(bundleName, newId);
      }
    }

    // Group card ids by their target bundle id and bulk-update each group
    const groupsByTarget = new Map<string, string[]>();
    for (const { cardId, bundleName } of cardBundles) {
      const targetBundleId = bundleNameToTargetId.get(bundleName)!;
      const group = groupsByTarget.get(targetBundleId) ?? [];
      group.push(cardId);
      groupsByTarget.set(targetBundleId, group);
    }

    for (const [targetBundleId, ids] of groupsByTarget) {
      await tx
        .update(cardTable)
        .set({ bundleId: targetBundleId })
        .where(inArray(cardTable.id, ids));
    }

    // Cards moved cross-project must leave their glue groups: a glue group
    // spanning two projects is never visible in the UI and leaves stale rows.
    await unglueCardsInTx(tx, cardIds);

    return true;
  });
}

type DeleteBundleWithReassign = { db: DB; projectId: string; bundleId: string };

/**
 * Deletes a non-default bundle and reassigns its cards to the project's default
 * bundle, atomically. Throws NotFoundError if the bundle doesn't exist.
 */
export async function deleteBundleWithReassign({
  db,
  projectId,
  bundleId,
}: DeleteBundleWithReassign): Promise<{ defaultBundleId: string }> {
  return withTx(db, async (tx) => {
    const bundle = await getBundle({ db: tx, projectId, bundleId });
    if (!bundle) throw new NotFoundError(`Bundle projectId=${projectId} bundleId=${bundleId}`);
    if (bundle.isDefault) throw new DefaultBundleError();

    const defaultBundle = await getDefaultBundle({ db: tx, projectId });
    if (!defaultBundle) throw new Error("No default bundle found for this project");

    await reassignBundleCards({ db: tx, fromBundleId: bundleId, toBundleId: defaultBundle.id });
    await deleteBundle({ db: tx, projectId, bundleId });

    return { defaultBundleId: defaultBundle.id };
  });
}
