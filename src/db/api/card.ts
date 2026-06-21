import { bundleTable, cardTable } from "../schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyDB } from "../client.js";
import type { NeedsDB, NeedsBundle, Card } from "./types.js";
import { assertFound } from "./utils.js";
import { withTx, type DB } from "../tx.js";

// ── Simple operations (no ownership check) ────────────────────────────────────

export async function cardsInProject(
  db: AnyDB,
  projectId: string,
  cardIds: string[],
): Promise<string[]> {
  if (cardIds.length === 0) return [];
  const rows = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(inArray(cardTable.id, cardIds));
  return rows.map((r) => r.id);
}

export async function getAllCards({ db, bundleId }: NeedsBundle): Promise<Card[]> {
  return db.select().from(cardTable).where(eq(cardTable.bundleId, bundleId));
}

type GetCardsByBundles = NeedsDB & { bundleIds: string[] };
export async function getCardsByBundles({ db, bundleIds }: GetCardsByBundles): Promise<Card[]> {
  if (bundleIds.length === 0) return [];
  return db.select().from(cardTable).where(inArray(cardTable.bundleId, bundleIds));
}

type GetCard = NeedsBundle & { cardId: string };
export async function getCard({ db, bundleId, cardId }: GetCard): Promise<Card | undefined> {
  return db
    .select()
    .from(cardTable)
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .get();
}

type AddCard = NeedsBundle & {
  content: string;
  workingCopyId?: string;
  posX?: number;
  posY?: number;
};
export async function addCard({
  db,
  bundleId,
  content,
  workingCopyId,
  posX,
  posY,
}: AddCard): Promise<string> {
  const [row] = await db
    .insert(cardTable)
    .values({
      bundleId,
      content,
      workingCopyId,
      ...(posX !== undefined && { posX }),
      ...(posY !== undefined && { posY }),
    })
    .returning({ id: cardTable.id });
  return row.id;
}

type DeleteCard = NeedsBundle & { cardId: string };
export async function deleteCard({ db, bundleId, cardId }: DeleteCard): Promise<void> {
  const deleted = await db
    .delete(cardTable)
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .returning({ id: cardTable.id });
  assertFound(deleted, `Card bundleId=${bundleId} cardId=${cardId}`);
}

// ── Project-scoped transactional operations (verify ownership before mutating) ─

type DeleteCards = { db: DB; projectId: string; cardIds: string[] };
export async function deleteCards({ db, projectId, cardIds }: DeleteCards): Promise<boolean> {
  if (cardIds.length === 0) return true;
  const uniqueIds = [...new Set(cardIds)];
  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, uniqueIds);
    if (owned.length !== uniqueIds.length) return false;
    await tx.delete(cardTable).where(inArray(cardTable.id, uniqueIds));
    return true;
  });
}

type GetCardBundleNames = NeedsDB & { cardIds: string[] };
export async function getCardBundleNames({
  db,
  cardIds,
}: GetCardBundleNames): Promise<{ cardId: string; bundleId: string; bundleName: string }[]> {
  if (cardIds.length === 0) return [];
  const rows = await db
    .select({
      cardId: cardTable.id,
      bundleId: bundleTable.id,
      bundleName: bundleTable.name,
    })
    .from(cardTable)
    .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
    .where(inArray(cardTable.id, cardIds));
  return rows;
}

type ReassignBundleCards = NeedsDB & { fromBundleId: string; toBundleId: string };
export async function reassignBundleCards({
  db,
  fromBundleId,
  toBundleId,
}: ReassignBundleCards): Promise<void> {
  await db
    .update(cardTable)
    .set({ bundleId: toBundleId })
    .where(eq(cardTable.bundleId, fromBundleId));
}

type UpdateCard = NeedsDB & {
  cardId: string;
  bundleId: string;
  newBundleId?: string;
  content?: string;
  posX?: number;
  posY?: number;
};
type CardUpdate = Partial<
  Pick<typeof cardTable.$inferInsert, "content" | "posX" | "posY" | "bundleId">
>;

export async function updateCard({
  db,
  cardId,
  bundleId,
  newBundleId,
  content,
  posX,
  posY,
}: UpdateCard): Promise<void> {
  const fields: CardUpdate = {};
  if (content !== undefined) fields.content = content;
  if (posX !== undefined) fields.posX = posX;
  if (posY !== undefined) fields.posY = posY;
  if (newBundleId !== undefined) fields.bundleId = newBundleId;
  if (Object.keys(fields).length === 0) throw new Error("updateCard: no fields to update");
  const updated = await db
    .update(cardTable)
    .set(fields)
    .where(and(eq(cardTable.id, cardId), eq(cardTable.bundleId, bundleId)))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card cardId=${cardId}`);
}

export type CardPositionUpdate = {
  cardId: string;
  posX: number;
  posY: number;
};

function buildPositionCaseWhen(positions: CardPositionUpdate[]): { posX: SQL; posY: SQL } {
  const whenX = positions.map((p) => sql`WHEN ${p.cardId} THEN ${p.posX}`);
  const whenY = positions.map((p) => sql`WHEN ${p.cardId} THEN ${p.posY}`);
  return {
    posX: sql`CASE ${cardTable.id} ${sql.join(whenX, sql` `)} END`,
    posY: sql`CASE ${cardTable.id} ${sql.join(whenY, sql` `)} END`,
  };
}

type UpdateCardPositions = {
  db: DB;
  positions: CardPositionUpdate[];
};

export async function updateCardPositions({ db, positions }: UpdateCardPositions): Promise<void> {
  if (positions.length === 0) return;

  await withTx(db, async (tx) => {
    const ids = positions.map((p) => p.cardId);
    const updated = await tx
      .update(cardTable)
      .set(buildPositionCaseWhen(positions))
      .where(inArray(cardTable.id, ids))
      .returning({ id: cardTable.id });
    if (updated.length !== positions.length)
      throw new Error(
        `updateCardPositions: expected ${positions.length} updates, got ${updated.length}`,
      );
  });
}

type UpdateProjectCardPositions = {
  db: DB;
  projectId: string;
  positions: CardPositionUpdate[];
};

export async function updateProjectCardPositions({
  db,
  projectId,
  positions,
}: UpdateProjectCardPositions): Promise<boolean> {
  if (positions.length === 0) return true;

  return withTx(db, async (tx) => {
    const cardIds = positions.map((p) => p.cardId);
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return false;

    await tx
      .update(cardTable)
      .set(buildPositionCaseWhen(positions))
      .where(inArray(cardTable.id, cardIds));

    return true;
  });
}

type ReassignCardsToBundle = {
  db: DB;
  projectId: string;
  cardIds: string[];
  bundleId: string;
};

export async function reassignCardsToBundle({
  db,
  projectId,
  cardIds,
  bundleId,
}: ReassignCardsToBundle): Promise<boolean> {
  if (cardIds.length === 0) return true;

  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return false;

    const bundle = await tx
      .select({ id: bundleTable.id })
      .from(bundleTable)
      .where(and(eq(bundleTable.id, bundleId), eq(bundleTable.projectId, projectId)))
      .get();
    if (!bundle) return false;

    await tx.update(cardTable).set({ bundleId }).where(inArray(cardTable.id, cardIds));

    return true;
  });
}
