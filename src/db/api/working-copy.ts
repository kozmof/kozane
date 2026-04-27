import { cardTable, workingCopyTable } from "../schema";
import { eq, getTableColumns, isNull } from "drizzle-orm";
import type { NeedsDB, NeedsScope, WorkingCopy } from "./types";
import { assertFound } from "./utils";

// scopeId is possibly null
export async function getAllWorkingCopies({ db }: NeedsDB): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable);
}

export async function addWorkingCopy({ db, scopeId }: NeedsScope): Promise<string> {
  const [row] = await db
    .insert(workingCopyTable)
    .values({ scopeId })
    .returning({ id: workingCopyTable.id });
  return row.id;
}

type GetWorkingCopy = NeedsDB & { workingCopyId: string };
export async function getWorkingCopy({
  db,
  workingCopyId,
}: GetWorkingCopy): Promise<WorkingCopy | undefined> {
  return db.select().from(workingCopyTable).where(eq(workingCopyTable.id, workingCopyId)).get();
}

type DeleteWorkingCopy = NeedsDB & { workingCopyId: string };
export async function deleteWorkingCopy({ db, workingCopyId }: DeleteWorkingCopy): Promise<void> {
  const deleted = await db
    .delete(workingCopyTable)
    .where(eq(workingCopyTable.id, workingCopyId))
    .returning({ id: workingCopyTable.id });
  assertFound(deleted, `WorkingCopy workingCopyId=${workingCopyId}`);
}
