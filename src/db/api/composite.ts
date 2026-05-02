import { withTx, type DB } from "../client.js";
import { addCard } from "./card.js";
import { addScopeRel } from "./scope-rel.js";
import { getWorkingCopy } from "./working-copy.js";
import { NotFoundError } from "./utils.js";

// createCardFromWorkingCopy must start a transaction, so it requires the outer DB connection,
// not a Tx handle (transactions cannot be nested in libsql).
type CreateCardFromWorkingCopy = {
  db: DB;
  workingCopyId: string;
  bundleId: string;
  content: string;
};

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
  return withTx(db, async (tx) => {
    const wc = await getWorkingCopy({ db: tx, workingCopyId });
    if (!wc) throw new NotFoundError(`WorkingCopy workingCopyId=${workingCopyId}`);
    const cardId = await addCard({ db: tx, bundleId, content, workingCopyId });
    if (wc.scopeId) {
      await addScopeRel({ db: tx, scopeId: wc.scopeId, cardId });
    }
    return cardId;
  });
}
