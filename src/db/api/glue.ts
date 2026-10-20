import { partitionTable, cardTable, glueTable, glueRelTable } from "../schema.js";
import { and, count, eq, getTableColumns, inArray } from "drizzle-orm";
import type { GlueRel, NeedsDB, NeedsNamespace, NeedsTx } from "./types.js";
import { withTx, type DB, type Tx } from "../tx.js";
import { cardsBelongToNamespace, isStored } from "./card.js";
import { BATCH_MAX, chunked } from "../../lib/constants.js";
import { columnCount, readByIds, type BatchResult } from "./utils.js";

/**
 * Read glue relations for a bounded selection of cards. Callers must keep the selection
 * within the statement's parameter budget.
 *
 * Use {@link getGlueRelsByNamespace} for a complete board. This function deliberately does
 * not batch large selections because polling a board that way would require repeated queries.
 */
export async function getGlueRelsByCards({
  db,
  cardIds,
}: NeedsDB & { cardIds: string[] }): Promise<GlueRel[]> {
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
  // with no remaining rows. Each batch holds whole groups, so its counts are complete.
  const memberCounts = await readByIds(affectedGlueIds, (batch) =>
    db
      .select({ glueId: glueRelTable.glueId, members: count() })
      .from(glueRelTable)
      .where(inArray(glueRelTable.glueId, batch))
      .groupBy(glueRelTable.glueId),
  );

  const survivors = new Set(
    memberCounts.filter(({ members }) => members > 1).map(({ glueId }) => glueId),
  );
  const orphanGlueIds = affectedGlueIds.filter((glueId) => !survivors.has(glueId));

  if (orphanGlueIds.length === 0) return [];

  // Collect lone members before deleting so callers know which cards were cleared.
  const loneRels = await readByIds(orphanGlueIds, (batch) =>
    db
      .select({ cardId: glueRelTable.cardId })
      .from(glueRelTable)
      .where(inArray(glueRelTable.glueId, batch)),
  );

  for (const batch of chunked(orphanGlueIds, { size: BATCH_MAX })) {
    await db.delete(glueRelTable).where(inArray(glueRelTable.glueId, batch));
    await db.delete(glueTable).where(inArray(glueTable.id, batch));
  }

  return loneRels.map((r) => r.cardId);
}

/**
 * Remove cards from their groups, then dissolve groups left with fewer than two cards. Return
 * the lone cards of those dissolved groups, which may include cards outside `cardIds`.
 */
async function detachCards(db: Tx, cardIds: string[]): Promise<string[]> {
  const existingRels = await readByIds(cardIds, (batch) =>
    db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, batch)),
  );

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  for (const batch of chunked(cardIds, { size: BATCH_MAX }))
    await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, batch));

  return dissolveOrphanGroups(db, affectedGlueIds);
}

/**
 * A new group, plus the cards outside it that gluing left ungrouped by emptying their old
 * groups. Clients clear `clearedCardIds` so a dissolved group does not linger until the next
 * poll.
 */
type GlueOutcome = { glueId: string; clearedCardIds: string[] };

async function glueCardsCore(db: Tx, cardIds: string[]): Promise<GlueOutcome> {
  if (cardIds.length < 2) throw new Error("glueCards requires at least 2 cards");
  if (new Set(cardIds).size !== cardIds.length)
    throw new Error("glueCards: cardIds must be unique");

  // Remove selected cards from their existing groups.
  const glued = new Set(cardIds);
  const clearedCardIds = (await detachCards(db, cardIds)).filter((id) => !glued.has(id));

  // Create a new glue group for all specified cards.
  const [{ id: newGlueId }] = await db.insert(glueTable).values({}).returning({ id: glueTable.id });
  // Chunk glue-member inserts within the parameter limit.
  for (const batch of chunked(cardIds, { columnsPerRow: columnCount(glueRelTable) }))
    await db.insert(glueRelTable).values(batch.map((cardId) => ({ glueId: newGlueId, cardId })));

  return { glueId: newGlueId, clearedCardIds };
}

async function unglueCardsCore(db: Tx, cardIds: string[]): Promise<string[]> {
  const dissolvedCardIds = await detachCards(db, cardIds);

  return [...new Set([...cardIds, ...dissolvedCardIds])];
}

type GlueCards = { db: DB; cardIds: string[] };
export async function glueCards({ db, cardIds }: GlueCards): Promise<string> {
  return withTx(db, async (tx) => (await glueCardsCore(tx, cardIds)).glueId);
}

type UnglueCards = { db: DB; cardIds: string[] };
export async function unglueCards({ db, cardIds }: UnglueCards): Promise<string[]> {
  if (cardIds.length === 0) return [];
  return withTx(db, (tx) => unglueCardsCore(tx, cardIds));
}

/**
 * Remove the given cards from their glue groups and dissolve groups left with fewer than two
 * cards. Runs inside an existing transaction. Returns every card left without a group, as
 * {@link unglueCards} does.
 */
export async function unglueCardsInTx({
  db,
  cardIds,
}: NeedsTx & { cardIds: string[] }): Promise<string[]> {
  if (cardIds.length === 0) return [];
  return unglueCardsCore(db, cardIds);
}

type GlueNamespaceCards = { db: DB; namespaceId: string; cardIds: string[] };

/**
 * Return the new group ID or a specific refusal reason. Share the result vocabulary with
 * {@link CardBatchResult} so routes can use the same error helper.
 */
export type GlueResult = BatchResult<"foreign-cards" | "stored-cards", GlueOutcome>;

/** Whether any of the cards sits in an inventory. */
async function anyStored(tx: Tx, cardIds: string[]): Promise<boolean> {
  const rows = await readByIds(cardIds, (batch) =>
    tx
      .select({ id: cardTable.id })
      .from(cardTable)
      .where(and(inArray(cardTable.id, batch), isStored))
      .limit(1),
  );
  return rows.length > 0;
}

/**
 * Glue cards after verifying that all belong to `namespaceId` and none is stored.
 * Storing a card removes it from its glue group.
 */
export async function glueNamespaceCards({
  db,
  namespaceId,
  cardIds,
}: GlueNamespaceCards): Promise<GlueResult> {
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToNamespace({ db: tx, namespaceId, cardIds });
    if (!owned.ok) return owned;
    if (await anyStored(tx, cardIds)) return { ok: false, reason: "stored-cards" };
    return { ok: true, ...(await glueCardsCore(tx, cardIds)) };
  });
}

type UnglueNamespaceCards = { db: DB; namespaceId: string; cardIds: string[] };

/** The cards left ungrouped, or the refusal. See {@link GlueResult}. */
export type UnglueResult = BatchResult<"foreign-cards", { clearedCardIds: string[] }>;

/** Unglue cards after verifying that all belong to `namespaceId`. */
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
