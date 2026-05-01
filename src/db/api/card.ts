import { cardTable } from "../schema";
import { and, eq, inArray } from "drizzle-orm";
import type { NeedsDB, NeedsBundle, Card } from "./types";
import { assertFound } from "./utils";

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
  const fields: Record<string, unknown> = {};
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
