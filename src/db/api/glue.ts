import { bundleTable, cardTable, glueTable, glueRelTable } from "../schema.js";
import { count, eq, getTableColumns, inArray } from "drizzle-orm";
import type { GlueRel, NeedsDB, NeedsProject, NeedsTx } from "./types.js";
import { withTx, type DB, type Tx } from "../tx.js";
import { cardsBelongToProject } from "./card.js";
import { chunked } from "../../lib/constants.js";
import { columnCount } from "./utils.js";

/**
 * The glue rows of a named handful of cards. For a caller that already holds the ids and
 * knows how many there are — a route acting on a selection, which `BATCH_MAX` caps.
 *
 * Not for the board: see {@link getGlueRelsByProject}.
 */
export async function getGlueRelsByCards({ db, cardIds }: NeedsDB & { cardIds: string[] }) {
  if (cardIds.length === 0) return [];
  return db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));
}

/**
 * Every glue row of a project's cards, selected by the project rather than by naming them.
 *
 * The same answer {@link getGlueRelsByCards} gives when handed every card of a project, and
 * the reason it is a separate function is the "every": that form binds one SQL parameter
 * per card, and the board asks for it on every page load and every snapshot poll. SQLite
 * refuses a statement past its variable limit — and builds the whole thing in memory before
 * finding out — so a project large enough stops loading rather than loading slowly. It is
 * the one read that took an id list nothing bounded: `BATCH_MAX` caps what a *request* may
 * name, and this list came out of the database.
 *
 * The join binds one parameter whatever the board holds, and walks indexes the schema
 * already has at every step: `bundle`'s primary key from `card`, and `glue_rel`'s from the
 * card side, whose `card_id` is itself the primary key.
 */
export async function getGlueRelsByProject({ db, projectId }: NeedsProject): Promise<GlueRel[]> {
  return db
    .select(getTableColumns(glueRelTable))
    .from(glueRelTable)
    .innerJoin(cardTable, eq(cardTable.id, glueRelTable.cardId))
    .innerJoin(bundleTable, eq(bundleTable.id, cardTable.bundleId))
    .where(eq(bundleTable.projectId, projectId));
}

/**
 * Dissolves any of `glueIds` left holding fewer than two cards, for callers that removed
 * the cards themselves. Deleting a card through a cascade — a project going away takes its
 * bundles, their cards, and those cards' `glue_rel` rows with it — never passes through
 * this module, so the parent `glue` rows would survive with nothing pointing at them.
 * Collect the ids before the cascade; they cannot be found afterwards.
 */
export async function dissolveOrphanGlueGroupsInTx({
  db,
  glueIds,
}: NeedsTx & { glueIds: string[] }): Promise<void> {
  await dissolveOrphanGroups(db, [...new Set(glueIds)]);
}

async function dissolveOrphanGroups(db: Tx, affectedGlueIds: string[]): Promise<string[]> {
  if (affectedGlueIds.length === 0) return [];

  // Survivors are counted and then subtracted, rather than selecting orphans with
  // `HAVING count() <= 1`: a group whose members were *all* removed produces no
  // GROUP BY row at all, so a HAVING filter can never see it and its `glue` row
  // would leak. Anything not proven to still hold ≥2 members is an orphan.
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
  // Chunked like every other bulk insert here: a route may name up to `BATCH_MAX` cards,
  // and a row per card at two columns each puts one statement well past the parameter
  // budget `STATEMENT_PARAMS_MAX` sets.
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

type GlueProjectCards = { db: DB; projectId: string; cardIds: string[] };

/**
 * The new group, or the refusal. A tagged result rather than the `string | null` this was:
 * `null` is a serviceable "no" while ownership is the only way to be told it, and stops
 * being one the moment a second reason is added — every caller reading it would go on
 * reporting the first. Same argument as {@link CardBatchResult}, and the same vocabulary,
 * so one route helper words them all.
 */
export type GlueResult = { ok: true; glueId: string } | { ok: false; reason: "foreign-cards" };

/** Glues cards together after verifying all belong to projectId. */
export async function glueProjectCards({
  db,
  projectId,
  cardIds,
}: GlueProjectCards): Promise<GlueResult> {
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToProject({ db: tx, projectId, cardIds });
    if (!owned.ok) return owned;
    return { ok: true, glueId: await glueCardsCore(tx, cardIds) };
  });
}

type UnglueProjectCards = { db: DB; projectId: string; cardIds: string[] };

/** The cards left ungrouped, or the refusal. See {@link GlueResult}. */
export type UnglueResult =
  | { ok: true; clearedCardIds: string[] }
  | { ok: false; reason: "foreign-cards" };

/** Unglues cards after verifying all belong to projectId. */
export async function unglueProjectCards({
  db,
  projectId,
  cardIds,
}: UnglueProjectCards): Promise<UnglueResult> {
  if (cardIds.length === 0) return { ok: true, clearedCardIds: [] };
  return withTx(db, async (tx) => {
    const owned = await cardsBelongToProject({ db: tx, projectId, cardIds });
    if (!owned.ok) return owned;
    return { ok: true, clearedCardIds: await unglueCardsCore(tx, cardIds) };
  });
}
