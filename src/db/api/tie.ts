import { tieTable } from "../schema";
import { eq, or } from "drizzle-orm";
import type { NeedsDB, Tie } from "./types";
import { assertFound } from "./utils";

export async function getTiesByCard({ db, cardId }: NeedsDB & { cardId: string }): Promise<Tie[]> {
  return db
    .select()
    .from(tieTable)
    .where(or(eq(tieTable.fromCardId, cardId), eq(tieTable.toCardId, cardId)));
}

type AddTie = NeedsDB & { fromCardId: string; toCardId: string; relType?: string };
export async function addTie({ db, fromCardId, toCardId, relType }: AddTie): Promise<string> {
  const [row] = await db
    .insert(tieTable)
    .values({ fromCardId, toCardId, relType })
    .returning({ id: tieTable.id });
  return row.id;
}

type DeleteTie = NeedsDB & { tieId: string };
export async function deleteTie({ db, tieId }: DeleteTie): Promise<void> {
  const deleted = await db
    .delete(tieTable)
    .where(eq(tieTable.id, tieId))
    .returning({ id: tieTable.id });
  assertFound(deleted, `Tie tieId=${tieId}`);
}
