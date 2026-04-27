import { cardTable, workingCopyTable } from "../schema";
import { eq, getTableColumns, isNull } from "drizzle-orm";
import type { WithDB, WithScope, Card, WorkingCopy } from "./types";
import { assertFound } from "./utils";

export async function getAllWorkingCopies({ db, scopeId }: WithScope): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable).where(eq(workingCopyTable.scopeId, scopeId));
}

// Returns working copies whose scope was deleted (scopeId set to null on scope delete)
export async function getAllOrphanedWorkingCopies({ db }: WithDB): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable).where(isNull(workingCopyTable.scopeId));
}

// Returns cards whose working copy has lost its scope (second-level orphan chain from scope deletion)
export async function getAllCardsWithOrphanedWorkingCopy({ db }: WithDB): Promise<Card[]> {
  return db
    .select(getTableColumns(cardTable))
    .from(cardTable)
    .innerJoin(workingCopyTable, eq(cardTable.workingCopyId, workingCopyTable.id))
    .where(isNull(workingCopyTable.scopeId));
}

export async function addWorkingCopy({ db, scopeId }: WithScope): Promise<string> {
  const [row] = await db
    .insert(workingCopyTable)
    .values({ scopeId })
    .returning({ id: workingCopyTable.id });
  return row.id;
}

type GetWorkingCopy = WithDB & { workingCopyId: string };
export async function getWorkingCopy({
  db,
  workingCopyId,
}: GetWorkingCopy): Promise<WorkingCopy | undefined> {
  return db.select().from(workingCopyTable).where(eq(workingCopyTable.id, workingCopyId)).get();
}

type DeleteWorkingCopy = WithDB & { workingCopyId: string };
export async function deleteWorkingCopy({ db, workingCopyId }: DeleteWorkingCopy): Promise<void> {
  const deleted = await db
    .delete(workingCopyTable)
    .where(eq(workingCopyTable.id, workingCopyId))
    .returning({ id: workingCopyTable.id });
  assertFound(deleted, `WorkingCopy workingCopyId=${workingCopyId}`);
}
