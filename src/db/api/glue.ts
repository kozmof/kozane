import { glueTable, glueRelTable } from "../schema.js";
import { and, count, inArray, lte, notInArray } from "drizzle-orm";
import type { NeedsDB } from "./types.js";
import { withTx, type DB, type AnyDB } from "../tx.js";
import { v7 as uuidv7 } from "uuid";

export async function getGlueRelsByCards({ db, cardIds }: NeedsDB & { cardIds: string[] }) {
  if (cardIds.length === 0) return [];
  return db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));
}

async function dissolveOrphanGroups(db: AnyDB, affectedGlueIds: string[]): Promise<void> {
  if (affectedGlueIds.length === 0) return;

  // Groups with ≤1 remaining member should be dissolved.
  const dissolveSubquery = db
    .select({ id: glueRelTable.glueId })
    .from(glueRelTable)
    .where(inArray(glueRelTable.glueId, affectedGlueIds))
    .groupBy(glueRelTable.glueId)
    .having(lte(count(), 1));

  // Remove any remaining lone glue_rel entries for those groups.
  await db.delete(glueRelTable).where(inArray(glueRelTable.glueId, dissolveSubquery));

  // Remove glue records that now have no glue_rel entries at all.
  const stillLinked = db
    .select({ id: glueRelTable.glueId })
    .from(glueRelTable)
    .where(inArray(glueRelTable.glueId, affectedGlueIds));

  await db
    .delete(glueTable)
    .where(and(inArray(glueTable.id, affectedGlueIds), notInArray(glueTable.id, stillLinked)));
}

async function glueCardsCore(db: AnyDB, cardIds: string[]): Promise<string> {
  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  // Remove selected cards from their existing groups.
  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  await dissolveOrphanGroups(db, affectedGlueIds);

  // Create a new glue group for all specified cards.
  const newGlueId = uuidv7();
  await db.insert(glueTable).values({ id: newGlueId });
  await db.insert(glueRelTable).values(cardIds.map((cardId) => ({ glueId: newGlueId, cardId })));

  return newGlueId;
}

async function unglueCardsCore(db: AnyDB, cardIds: string[]): Promise<void> {
  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  await dissolveOrphanGroups(db, affectedGlueIds);
}

export async function glueCards({
  db,
  cardIds,
}: { db: DB } & { cardIds: string[] }): Promise<string> {
  if (cardIds.length < 2) throw new Error("glueCards requires at least 2 cards");
  return withTx(db, (tx) => glueCardsCore(tx, cardIds));
}

export async function unglueCards({
  db,
  cardIds,
}: { db: DB } & { cardIds: string[] }): Promise<void> {
  if (cardIds.length === 0) return;
  return withTx(db, (tx) => unglueCardsCore(tx, cardIds));
}
