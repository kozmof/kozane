import { error } from "@sveltejs/kit";
import { partitionTable, cardTable } from "$db/schema";
import { and, eq } from "drizzle-orm";
import type { AnyDB } from "$db/client";
import type { Card } from "$db/api/types";

/** Verify card ownership through its partition. Throw 404 for a missing or foreign card. */
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
