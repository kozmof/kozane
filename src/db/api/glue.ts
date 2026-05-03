import { glueTable, glueRelTable } from "../schema.js";
import { eq, inArray } from "drizzle-orm";
import type { NeedsDB } from "./types.js";
import { v7 as uuidv7 } from "uuid";

export type GlueRel = { glueId: string; cardId: string };

export async function getGlueRelsByCards({
  db,
  cardIds,
}: NeedsDB & { cardIds: string[] }): Promise<GlueRel[]> {
  if (cardIds.length === 0) return [];
  return db.select().from(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));
}

export async function glueCards({
  db,
  cardIds,
}: NeedsDB & { cardIds: string[] }): Promise<string> {
  if (cardIds.length < 2) throw new Error("glueCards requires at least 2 cards");

  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  // Remove selected cards from their existing groups
  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  // Clean up glue groups that now have <=1 member
  for (const glueId of affectedGlueIds) {
    const remaining = await db
      .select()
      .from(glueRelTable)
      .where(eq(glueRelTable.glueId, glueId));
    if (remaining.length <= 1) {
      await db.delete(glueRelTable).where(eq(glueRelTable.glueId, glueId));
      await db.delete(glueTable).where(eq(glueTable.id, glueId));
    }
  }

  // Create new glue group
  const newGlueId = uuidv7();
  await db.insert(glueTable).values({ id: newGlueId });
  await db.insert(glueRelTable).values(cardIds.map((cardId) => ({ glueId: newGlueId, cardId })));

  return newGlueId;
}

export async function unglueCards({
  db,
  cardIds,
}: NeedsDB & { cardIds: string[] }): Promise<void> {
  if (cardIds.length === 0) return;

  const existingRels = await db
    .select()
    .from(glueRelTable)
    .where(inArray(glueRelTable.cardId, cardIds));

  const affectedGlueIds = [...new Set(existingRels.map((r) => r.glueId))];

  await db.delete(glueRelTable).where(inArray(glueRelTable.cardId, cardIds));

  for (const glueId of affectedGlueIds) {
    const remaining = await db
      .select()
      .from(glueRelTable)
      .where(eq(glueRelTable.glueId, glueId));
    if (remaining.length <= 1) {
      await db.delete(glueRelTable).where(eq(glueRelTable.glueId, glueId));
      await db.delete(glueTable).where(eq(glueTable.id, glueId));
    }
  }
}
