import { cardTable } from "../schema";
import { and, eq } from "drizzle-orm";
import type { WithBundle, Card } from "./types";
import { assertFound } from "./utils";

type CardBase = WithBundle;

export async function listCards({ db, bundleId }: CardBase): Promise<Card[]> {
  return db.select().from(cardTable).where(eq(cardTable.bundleId, bundleId));
}

type GetCard = CardBase & { cardId: string };
export async function getCard({ db, bundleId, cardId }: GetCard): Promise<Card | undefined> {
  return db
    .select()
    .from(cardTable)
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .get();
}

type AddCard = CardBase & { content: string; workingCopyId?: string };
export async function addCard({ db, bundleId, content, workingCopyId }: AddCard): Promise<string> {
  const [row] = await db
    .insert(cardTable)
    .values({ bundleId, content, workingCopyId })
    .returning({ id: cardTable.id });
  return row.id;
}

type DeleteCard = CardBase & { cardId: string };
export async function deleteCard({ db, bundleId, cardId }: DeleteCard): Promise<void> {
  const deleted = await db
    .delete(cardTable)
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .returning({ id: cardTable.id });
  assertFound(deleted, `Card bundleId=${bundleId} cardId=${cardId}`);
}

type UpdateCardContent = CardBase & { cardId: string; content: string };
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
