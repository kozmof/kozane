import { glueTable, glueRelTable } from "../schema.js";
import { count, inArray, lte } from "drizzle-orm";
import type { NeedsDB } from "./types.js";
import { withTx, type DB, type Tx } from "../tx.js";
import { cardsInProject } from "./card.js";

export async function getGlueRelsByCards({ db, cardIds }: NeedsDB & { cardIds: string[] }) {
  if (cardIds.length === 0) return [];
  return db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));
}

async function dissolveOrphanGroups(db: Tx, affectedGlueIds: string[]): Promise<string[]> {
  if (affectedGlueIds.length === 0) return [];

  // Find groups with ≤1 remaining member.
  const orphanGroups = await db
    .select({ glueId: glueRelTable.glueId })
    .from(glueRelTable)
    .where(inArray(glueRelTable.glueId, affectedGlueIds))
    .groupBy(glueRelTable.glueId)
    .having(lte(count(), 1));

  if (orphanGroups.length === 0) return [];

  const orphanGlueIds = orphanGroups.map((r) => r.glueId);

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
  await db.insert(glueRelTable).values(cardIds.map((cardId) => ({ glueId: newGlueId, cardId })));

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
export async function unglueCardsInTx(db: Tx, cardIds: string[]): Promise<void> {
  if (cardIds.length === 0) return;
  await unglueCardsCore(db, cardIds);
}

type GlueProjectCards = { db: DB; projectId: string; cardIds: string[] };
/** Glues cards together after verifying all belong to projectId. Returns null on ownership failure. */
export async function glueProjectCards({
  db,
  projectId,
  cardIds,
}: GlueProjectCards): Promise<string | null> {
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return null;
    return glueCardsCore(tx, cardIds);
  });
}

type UnglueProjectCards = { db: DB; projectId: string; cardIds: string[] };
/** Unglues cards after verifying all belong to projectId. Returns null on ownership failure. */
export async function unglueProjectCards({
  db,
  projectId,
  cardIds,
}: UnglueProjectCards): Promise<string[] | null> {
  if (cardIds.length === 0) return [];
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return null;
    return unglueCardsCore(tx, cardIds);
  });
}
