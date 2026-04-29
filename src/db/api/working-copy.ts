import { workingCopyTable } from "../schema";
import { eq } from "drizzle-orm";
import type { NeedsDB, NeedsScope, NeedsWorkingCopy, WorkingCopy } from "./types";
import { assertFound } from "./utils";

// scopeId is possibly null
export async function getAllWorkingCopies({ db }: NeedsDB): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable);
}

type AddWorkingCopy = NeedsScope & { name?: string; dirPath?: string };
export async function addWorkingCopy({ db, scopeId, name = "", dirPath }: AddWorkingCopy): Promise<string> {
  const [row] = await db
    .insert(workingCopyTable)
    .values({ scopeId, name, dirPath })
    .returning({ id: workingCopyTable.id });
  return row.id;
}

type UpdateWorkingCopy = NeedsWorkingCopy & { name?: string; dirPath?: string };
export async function updateWorkingCopy({ db, workingCopyId, name, dirPath }: UpdateWorkingCopy): Promise<void> {
  const updated = await db
    .update(workingCopyTable)
    .set({ ...(name !== undefined && { name }), ...(dirPath !== undefined && { dirPath }) })
    .where(eq(workingCopyTable.id, workingCopyId))
    .returning({ id: workingCopyTable.id });
  assertFound(updated, `WorkingCopy workingCopyId=${workingCopyId}`);
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
