import { withTx, type DB, type AnyDB } from "../client.js";
import { addCard } from "./card.js";
import { addScopeRel } from "./scope-rel.js";
import { getWorkingCopy } from "./working-copy.js";
import { NotFoundError } from "./utils.js";

type CreateCardFromWorkingCopy = {
  db: DB;
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
export async function createCardInWorkingCopyContext(
  db: AnyDB,
  {
    workingCopyId,
    bundleId,
    content,
  }: { workingCopyId: string; bundleId: string; content: string },
): Promise<string> {
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
  return withTx(db, (tx) => createCardInWorkingCopyContext(tx, { workingCopyId, bundleId, content }));
}
