import { withTx, type DB, type AnyDB } from "../tx.js";
import { addCard, reassignBundleCards, cardsInProject, getCardBundleNames } from "./card.js";
import { deleteBundle, getBundle, getDefaultBundle, getAllBundles, addBundle } from "./bundle.js";
import { addScopeRel } from "./scope-rel.js";
import { getWorkingCopy } from "./working-copy.js";
import { NotFoundError } from "./utils.js";
import { inArray } from "drizzle-orm";
import { cardTable } from "../schema.js";

type CreateCardFromWorkingCopy = {
  db: DB;
  workingCopyId: string;
  bundleId: string;
  content: string;
};

type CreateCardInWorkingCopyContext = {
  db: AnyDB;
  workingCopyId: string;
  bundleId: string;
  content: string;
};

/**
 * Core logic for creating a card within a working-copy context.
 * Exported separately so it can be tested without a transaction.
 * Production callers should use `createCardFromWorkingCopy`, which wraps
 * this in a transaction to keep the card insert and scope_rel insert atomic.
 */
export async function createCardInWorkingCopyContext({
  db,
  workingCopyId,
  bundleId,
  content,
}: CreateCardInWorkingCopyContext): Promise<string> {
  const wc = await getWorkingCopy({ db, workingCopyId });
  if (!wc) throw new NotFoundError(`WorkingCopy workingCopyId=${workingCopyId}`);
  const cardId = await addCard({ db, bundleId, content, workingCopyId });
  if (wc.scopeId) {
    await addScopeRel({ db, scopeId: wc.scopeId, cardId });
  }
  return cardId;
}

/**
 * Creates a card in the given bundle within a working-copy context.
 * If the working copy is still attached to a scope, the new card is
 * simultaneously registered in scope_rel (auto-add, 7-1), making the
 * "originated" and "gathered" relationships consistent from creation time.
 * Throws NotFoundError when workingCopyId does not exist.
 */
export async function createCardFromWorkingCopy({
  db,
  workingCopyId,
  bundleId,
  content,
}: CreateCardFromWorkingCopy): Promise<string> {
  return withTx(db, (tx) =>
    createCardInWorkingCopyContext({ db: tx, workingCopyId, bundleId, content }),
  );
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
    if (bundle.isDefault) throw new Error("Cannot delete the default bundle");

    const defaultBundle = await getDefaultBundle({ db: tx, projectId });
    if (!defaultBundle) throw new Error("No default bundle found for this project");

    await reassignBundleCards({ db: tx, fromBundleId: bundleId, toBundleId: defaultBundle.id });
    await deleteBundle({ db: tx, projectId, bundleId });

    return { defaultBundleId: defaultBundle.id };
  });
}
