import { partitionTable, cardTable, glueTable, glueRelTable } from "../schema.js";
import { count, eq, getTableColumns, inArray } from "drizzle-orm";
import type { GlueRel, NeedsDB, NeedsNamespace, NeedsTx } from "./types.js";
import { withTx, type DB, type Tx } from "../tx.js";
import { cardsBelongToNamespace } from "./card.js";
import { chunked } from "../../lib/constants.js";
import { columnCount, type BatchResult } from "./utils.js";

/**
 * Read glue relations for a bounded selection of cards. Callers must keep the selection
 * within the statement's parameter budget.
 *
 * Use {@link getGlueRelsByNamespace} for a complete board. This function deliberately does
 * not batch large selections because polling a board that way would require repeated queries.
 */
export async function getGlueRelsByCards({ db, cardIds }: NeedsDB & { cardIds: string[] }) {
  if (cardIds.length === 0) return [];
  return db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));
}

/**
 * Read all glue relations for a namespace through joins. Bind only the namespace ID so board
 * loads and snapshot polls remain independent of SQLite's parameter limit.
 */
export async function getGlueRelsByNamespace({
  db,
  namespaceId,
}: NeedsNamespace): Promise<GlueRel[]> {
  return db
    .select(getTableColumns(glueRelTable))
    .from(glueRelTable)
    .innerJoin(cardTable, eq(cardTable.id, glueRelTable.cardId))
    .innerJoin(partitionTable, eq(partitionTable.id, cardTable.partitionId))
    .where(eq(partitionTable.namespaceId, namespaceId));
}

/**
 * Dissolve groups with fewer than two cards after callers delete cards directly or through
 * cascades. Collect the glue IDs before deletion, while their relations still exist.
 */
export async function dissolveOrphanGlueGroupsInTx({
  db,
  glueIds,
}: NeedsTx & { glueIds: string[] }): Promise<void> {
  await dissolveOrphanGroups(db, [...new Set(glueIds)]);
}

async function dissolveOrphanGroups(db: Tx, affectedGlueIds: string[]): Promise<string[]> {
  if (affectedGlueIds.length === 0) return [];

  // Count surviving groups and subtract from the original count. HAVING cannot find groups
  // with no remaining rows.
  const memberCounts = await db
    .select({ glueId: glueRelTable.glueId, members: count() })
    .from(glueRelTable)
    .where(inArray(glueRelTable.glueId, affectedGlueIds))
    .groupBy(glueRelTable.glueId);

  const survivors = new Set(
    memberCounts.filter(({ members }) => members > 1).map(({ glueId }) => glueId),
  );
  const orphanGlueIds = affectedGlueIds.filter((glueId) => !survivors.has(glueId));

  if (orphanGlueIds.length === 0) return [];

  // Collect lone members before deleting so callers know which cards were cleared.
  const loneRels = await db
    .select({ cardId: glueRelTable.cardId })
    .from(glueRelTable)
    .where(inArray(glueRelTable.glueId, orphanGlueIds));

  await db.delete(glueRelTable).where(inArray(glueRelTable.glueId, orphanGlueIds));
  await db.delete(glueTable).where(inArray(glueTable.id, orphanGlueIds));

  return loneRels.map((r) => r.cardId);
}

async function glueCardsCore(db: Tx, cardIds: string[]): Promise<string> {
  if (cardIds.length < 2) throw new Error("glueCards requires at least 2 cards");
  if (new Set(cardIds).size !== cardIds.length)
    throw new Error("glueCards: cardIds must be unique");

  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  // Remove selected cards from their existing groups.
  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  await dissolveOrphanGroups(db, affectedGlueIds);

  // Create a new glue group for all specified cards.
  const [{ id: newGlueId }] = await db.insert(glueTable).values({}).returning({ id: glueTable.id });
  // Chunk glue-member inserts within the parameter limit.
  for (const batch of chunked(cardIds, { columnsPerRow: columnCount(glueRelTable) }))
    await db.insert(glueRelTable).values(batch.map((cardId) => ({ glueId: newGlueId, cardId })));

  return newGlueId;
}

async function unglueCardsCore(db: Tx, cardIds: string[]): Promise<string[]> {
  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  const dissolvedCardIds = await dissolveOrphanGroups(db, affectedGlueIds);

  return [...new Set([...cardIds, ...dissolvedCardIds])];
}

type GlueCards = { db: DB; cardIds: string[] };
export async function glueCards({ db, cardIds }: GlueCards): Promise<string> {
  return withTx(db, (tx) => glueCardsCore(tx, cardIds));
}

type UnglueCards = { db: DB; cardIds: string[] };
export async function unglueCards({ db, cardIds }: UnglueCards): Promise<string[]> {
  if (cardIds.length === 0) return [];
  return withTx(db, (tx) => unglueCardsCore(tx, cardIds));
}

/** Dissolves all glue groups containing any of the given cards. Runs inside an existing transaction. */
export async function unglueCardsInTx({
  db,
  cardIds,
}: NeedsTx & { cardIds: string[] }): Promise<void> {
  if (cardIds.length === 0) return;
  await unglueCardsCore(db, cardIds);
}

type GlueNamespaceCards = { db: DB; namespaceId: string; cardIds: string[] };

/**
 * Return the new group ID or a specific refusal reason. Share the result vocabulary with
 * {@link CardBatchResult} so routes can use the same error helper.
 */
export type GlueResult = BatchResult<"foreign-cards", { glueId: string }>;

/** Glues cards together after verifying all belong to namespaceId. */
export async function glueNamespaceCards({
  db,
  namespaceId,
  cardIds,
}: GlueNamespaceCards): Promise<GlueResult> {
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;
    return { ok: true, glueId: await glueCardsCore(tx, cardIds) };
  });
}

type UnglueNamespaceCards = { db: DB; namespaceId: string; cardIds: string[] };

/** The cards left ungrouped, or the refusal. See {@link GlueResult}. */
export type UnglueResult = BatchResult<"foreign-cards", { clearedCardIds: string[] }>;

/** Unglues cards after verifying all belong to namespaceId. */
export async function unglueNamespaceCards({
  db,
  namespaceId,
  cardIds,
}: UnglueNamespaceCards): Promise<UnglueResult> {
  if (cardIds.length === 0) return { ok: true, clearedCardIds: [] };
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;
    return { ok: true, clearedCardIds: await unglueCardsCore(tx, cardIds) };
  });
}
