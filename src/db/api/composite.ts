import { withTx, type DB } from "../client";
import { addCard } from "./card";
import { addScopeRel } from "./scope-rel";
import { getWorkingCopy } from "./working-copy";
import type { WithDB } from "./types";
import { NotFoundError } from "./utils";

type CreateCardFromWorkingCopy = WithDB & {
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
  const wc = await getWorkingCopy({ db, workingCopyId });
  if (!wc) throw new NotFoundError(`WorkingCopy workingCopyId=${workingCopyId}`);

  return withTx(db, async (tx) => {
    const cardId = await addCard({ db: tx as unknown as DB, bundleId, content, workingCopyId });
    if (wc.scopeId) {
      await addScopeRel({ db: tx as unknown as DB, scopeId: wc.scopeId, cardId });
    }
    return cardId;
  });
}
