import { tieTable } from "../schema";
import { and, eq, inArray, or } from "drizzle-orm";
import type { NeedsDB, NeedsTie, Tie } from "./types";
import { assertFound } from "./utils";

export async function getTiesByCard({ db, cardId }: NeedsDB & { cardId: string }): Promise<Tie[]> {
  return db
    .select()
    .from(tieTable)
    .where(or(eq(tieTable.fromCardId, cardId), eq(tieTable.toCardId, cardId)));
}

type GetTiesByCards = NeedsDB & { cardIds: string[] };
export async function getTiesByCards({ db, cardIds }: GetTiesByCards): Promise<Tie[]> {
  if (cardIds.length === 0) return [];
  return db
    .select()
    .from(tieTable)
    .where(or(inArray(tieTable.fromCardId, cardIds), inArray(tieTable.toCardId, cardIds)));
}

type AddTie = NeedsDB & { fromCardId: string; toCardId: string; relType?: string };
export async function addTie({ db, fromCardId, toCardId, relType }: AddTie): Promise<string> {
  const [row] = await db
    .insert(tieTable)
    .values({ fromCardId, toCardId, relType })
    .onConflictDoNothing()
    .returning({ id: tieTable.id });
  if (row) return row.id;
  // Conflict: the tie already exists — fetch its id
  const existing = await db
    .select({ id: tieTable.id })
    .from(tieTable)
    .where(and(eq(tieTable.fromCardId, fromCardId), eq(tieTable.toCardId, toCardId)))
    .get();
  return existing!.id;
}

export async function deleteTie({ db, tieId }: NeedsTie): Promise<void> {
  const deleted = await db
    .delete(tieTable)
    .where(eq(tieTable.id, tieId))
    .returning({ id: tieTable.id });
  assertFound(deleted, `Tie tieId=${tieId}`);
}
