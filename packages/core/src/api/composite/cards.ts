/** Card deletion with glue cleanup. */
import { withTx, type DB, type Tx } from "../../database.js";
import { cardsBelongToNamespace } from "../card.js";
import { unglueCardsInTx } from "../glue.js";
import type { CardBatchResult } from "../utils.js";
import { inArray } from "drizzle-orm";
import { cardTable } from "../../schema.js";
import { BATCH_MAX, chunked } from "../../constants/index.js";

type DeleteNamespaceCards = { db: DB; namespaceId: string; cardIds: string[] };

/**
 * Delete cards only if they all belong to the namespace. Dissolve glue groups left with fewer
 * than two cards.
 *
 * Card deletion cascades through `glue_rel` without running the glue helpers, so explicitly
 * clean up the affected groups.
 */
export async function deleteNamespaceCards(args: DeleteNamespaceCards): Promise<CardBatchResult> {
  return withTx(args.db, (tx) => deleteNamespaceCardsInTx({ ...args, db: tx }));
}
export async function deleteNamespaceCardsInTx({
  db: tx,
  namespaceId,
  cardIds,
}: Omit<DeleteNamespaceCards, "db"> & { db: Tx }): Promise<CardBatchResult> {
  if (cardIds.length === 0) return { ok: true };
  const uniqueIds = [...new Set(cardIds)];
  return (async () => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds: uniqueIds });
    if (!owned.ok) return owned;
    await unglueCardsInTx({ db: tx, cardIds: uniqueIds });
    for (const batch of chunked(uniqueIds, { size: BATCH_MAX }))
      await tx.delete(cardTable).where(inArray(cardTable.id, batch));
    return { ok: true };
  })();
}
