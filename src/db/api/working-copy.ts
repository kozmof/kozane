import { workingCopyTable } from "../schema";
import { eq, isNull } from "drizzle-orm";
import type { DB } from "../client";
import type { WorkingCopy } from "./types";
import { assertFound } from "./utils";

type WithScopeId = { db: DB; scopeId: string };

export async function listWorkingCopies({ db, scopeId }: WithScopeId): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable).where(eq(workingCopyTable.scopeId, scopeId));
}

// Returns working copies whose scope was deleted (scopeId set to null on scope delete)
export async function listOrphanedWorkingCopies({ db }: { db: DB }): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable).where(isNull(workingCopyTable.scopeId));
}

export async function addWorkingCopy({ db, scopeId }: WithScopeId): Promise<string> {
  const [row] = await db
    .insert(workingCopyTable)
    .values({ scopeId })
    .returning({ id: workingCopyTable.id });
  return row.id;
}

type GetWorkingCopy = { db: DB; workingCopyId: string };
export async function getWorkingCopy({
  db,
  workingCopyId,
}: GetWorkingCopy): Promise<WorkingCopy | undefined> {
  return db
    .select()
    .from(workingCopyTable)
    .where(eq(workingCopyTable.id, workingCopyId))
    .get();
}

type DeleteWorkingCopy = { db: DB; workingCopyId: string };
export async function deleteWorkingCopy({ db, workingCopyId }: DeleteWorkingCopy): Promise<void> {
  const deleted = await db
    .delete(workingCopyTable)
    .where(eq(workingCopyTable.id, workingCopyId))
    .returning({ id: workingCopyTable.id });
  assertFound(deleted, `WorkingCopy workingCopyId=${workingCopyId}`);
}
