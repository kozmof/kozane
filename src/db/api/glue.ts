import { glueTable, glueRelTable } from "../schema.js";
import { and, count, inArray, lte, notInArray } from "drizzle-orm";
import type { NeedsDB } from "./types.js";
import { withTx, type DB, type Tx } from "../tx.js";

export async function getGlueRelsByCards({ db, cardIds }: NeedsDB & { cardIds: string[] }) {
  if (cardIds.length === 0) return [];
  return db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));
}

async function dissolveOrphanGroups(db: Tx, affectedGlueIds: string[]): Promise<void> {
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
  await db
    .delete(glueTable)
    .where(
      and(
        inArray(glueTable.id, affectedGlueIds),
        notInArray(
          glueTable.id,
          db.select({ id: glueRelTable.glueId }).from(glueRelTable)
            .where(inArray(glueRelTable.glueId, affectedGlueIds)),
        ),
      ),
    );
}

async function glueCardsCore(db: Tx, cardIds: string[]): Promise<string> {
  if (cardIds.length < 2) throw new Error("glueCards requires at least 2 cards");
  if (new Set(cardIds).size !== cardIds.length) throw new Error("glueCards: cardIds must be unique");

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

async function unglueCardsCore(db: Tx, cardIds: string[]): Promise<void> {
  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  await dissolveOrphanGroups(db, affectedGlueIds);
}

type GlueCards = { db: DB; cardIds: string[] };
export async function glueCards({ db, cardIds }: GlueCards): Promise<string> {
  return withTx(db, (tx) => glueCardsCore(tx, cardIds));
}

type UnglueCards = { db: DB; cardIds: string[] };
export async function unglueCards({ db, cardIds }: UnglueCards): Promise<void> {
  if (cardIds.length === 0) return;
  return withTx(db, (tx) => unglueCardsCore(tx, cardIds));
}
