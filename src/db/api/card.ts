import { bundleTable, cardTable } from "../schema.js";
import { and, eq, inArray } from "drizzle-orm";
import type { NeedsDB, NeedsBundle, Card } from "./types.js";
import { assertFound } from "./utils.js";
import { withTx, type DB } from "../tx.js";

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

type UpdateCardContent = NeedsBundle & { cardId: string; content: string };
export async function updateCardContent({
  db,
  bundleId,
  cardId,
  content,
}: UpdateCardContent): Promise<void> {
  const updated = await db
    .update(cardTable)
    .set({ content })
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card bundleId=${bundleId} cardId=${cardId}`);
}

type UpdateCardPosition = NeedsDB & { cardId: string; posX: number; posY: number };
export async function updateCardPosition({
  db,
  cardId,
  posX,
  posY,
}: UpdateCardPosition): Promise<void> {
  const updated = await db
    .update(cardTable)
    .set({ posX, posY })
    .where(eq(cardTable.id, cardId))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card cardId=${cardId}`);
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
  content?: string;
  posX?: number;
  posY?: number;
  bundleId?: string;
};
export async function updateCard({
  db,
  cardId,
  content,
  posX,
  posY,
  bundleId,
}: UpdateCard): Promise<void> {
  type CardUpdate = Partial<
    Pick<typeof cardTable.$inferInsert, "content" | "posX" | "posY" | "bundleId">
  >;
  const fields: CardUpdate = {};
  if (content !== undefined) fields.content = content;
  if (posX !== undefined) fields.posX = posX;
  if (posY !== undefined) fields.posY = posY;
  if (bundleId !== undefined) fields.bundleId = bundleId;
  if (Object.keys(fields).length === 0) return;
  const updated = await db
    .update(cardTable)
    .set(fields)
    .where(eq(cardTable.id, cardId))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card cardId=${cardId}`);
}

export type CardPositionUpdate = {
  cardId: string;
  posX: number;
  posY: number;
};

type UpdateCardPositions = {
  db: DB;
  positions: CardPositionUpdate[];
};

export async function updateCardPositions({ db, positions }: UpdateCardPositions): Promise<void> {
  if (positions.length === 0) return;

  await withTx(db, async (tx) => {
    for (const { cardId, posX, posY } of positions) {
      const updated = await tx
        .update(cardTable)
        .set({ posX, posY })
        .where(eq(cardTable.id, cardId))
        .returning({ id: cardTable.id });
      assertFound(updated, `Card cardId=${cardId}`);
    }
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
    const cardIds = positions.map((position) => position.cardId);
    const owned = await tx
      .select({ id: cardTable.id })
      .from(cardTable)
      .innerJoin(
        bundleTable,
        and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
      )
      .where(inArray(cardTable.id, cardIds));

    if (owned.length !== cardIds.length) return false;

    for (const { cardId, posX, posY } of positions) {
      const updated = await tx
        .update(cardTable)
        .set({ posX, posY })
        .where(eq(cardTable.id, cardId))
        .returning({ id: cardTable.id });
      assertFound(updated, `Card projectId=${projectId} cardId=${cardId}`);
    }

    return true;
  });
}
