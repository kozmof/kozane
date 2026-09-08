import { error } from "@sveltejs/kit";
import { partitionTable, cardTable } from "$db/schema";
import { and, eq } from "drizzle-orm";
import type { AnyDB } from "$db/client";
import type { Card } from "$db/api/types";
import { cardsBelongToNamespace } from "$db/api/card";

/** Verifies a card belongs to the given namespace (via its partition). Throws 404 if not found. */
export async function requireCardInNamespace(
  db: AnyDB,
  namespaceId: string,
  cardId: string,
): Promise<Pick<Card, "id" | "partitionId">> {
  const card = await db
    .select({ id: cardTable.id, partitionId: cardTable.partitionId })
    .from(cardTable)
    .innerJoin(
      partitionTable,
      and(
        eq(cardTable.partitionId, partitionTable.id),
        eq(partitionTable.namespaceId, namespaceId),
      ),
    )
    .where(eq(cardTable.id, cardId))
    .get();

  if (!card) throw error(404, "Card not found");
  return card;
}

/** Returns true only if every cardId in the list belongs to the given namespace. */
export async function allCardsBelongToNamespace(
  db: AnyDB,
  namespaceId: string,
  cardIds: string[],
): Promise<boolean> {
  if (cardIds.length === 0) return true;
  return (await cardsBelongToNamespace({ db, namespaceId, cardIds })).ok;
}
