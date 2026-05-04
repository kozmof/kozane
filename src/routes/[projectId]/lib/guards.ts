import { error } from "@sveltejs/kit";
import { bundleTable, cardTable } from "../../../db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { AnyDB } from "../../../db/client";
import type { Card } from "../../../db/api/types";

/** Verifies a card belongs to the given project (via its bundle). Throws 404 if not found. */
export async function requireCardInProject(
  db: AnyDB,
  projectId: string,
  cardId: string,
): Promise<Pick<Card, "id" | "bundleId">> {
  const card = await db
    .select({ id: cardTable.id, bundleId: cardTable.bundleId })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(eq(cardTable.id, cardId))
    .get();

  if (!card) throw error(404, "Card not found");
  return card;
}

/** Returns true only if every cardId in the list belongs to the given project. */
export async function allCardsBelongToProject(
  db: AnyDB,
  projectId: string,
  cardIds: string[],
): Promise<boolean> {
  if (cardIds.length === 0) return true;
  const owned = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(inArray(cardTable.id, cardIds));
  return owned.length === cardIds.length;
}
