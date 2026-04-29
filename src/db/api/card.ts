import { cardTable } from "../schema";
import { and, eq } from "drizzle-orm";
import type { NeedsDB, NeedsBundle, Card } from "./types";
import { assertFound } from "./utils";

export async function getAllCards({ db, bundleId }: NeedsBundle): Promise<Card[]> {
  return db.select().from(cardTable).where(eq(cardTable.bundleId, bundleId));
}

type GetCard = NeedsBundle & { cardId: string };
export async function getCard({ db, bundleId, cardId }: GetCard): Promise<Card | undefined> {
  return db
    .select()
    .from(cardTable)
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .get();
}

type AddCard = NeedsBundle & { content: string; workingCopyId?: string };
export async function addCard({ db, bundleId, content, workingCopyId }: AddCard): Promise<string> {
  const [row] = await db
    .insert(cardTable)
    .values({ bundleId, content, workingCopyId })
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
export async function updateCardPosition({ db, cardId, posX, posY }: UpdateCardPosition): Promise<void> {
  const updated = await db
    .update(cardTable)
    .set({ posX, posY })
    .where(eq(cardTable.id, cardId))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card cardId=${cardId}`);
}
