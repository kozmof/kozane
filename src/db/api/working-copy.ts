import { workingCopyTable } from "../schema";
import { eq, sql } from "drizzle-orm";
import type { NeedsDB, NeedsScope, NeedsWorkingCopy, WorkingCopy } from "./types";
import { assertFound } from "./utils";

// scopeId is possibly null
export async function getAllWorkingCopies({ db }: NeedsDB): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable);
}

type AddWorkingCopy = NeedsScope & {
  projectId?: string;
  name?: string;
  path?: string;
  pathKind?: "project_relative" | "absolute";
};
export async function addWorkingCopy({
  db,
  scopeId,
  projectId,
  name = "",
  path,
  pathKind = "project_relative",
}: AddWorkingCopy): Promise<string> {
  const [row] = await db
    .insert(workingCopyTable)
    .values({ scopeId, projectId, name, path, pathKind })
    .returning({ id: workingCopyTable.id });
  return row.id;
}

type UpdateWorkingCopy = NeedsWorkingCopy & {
  name?: string;
  path?: string;
  pathKind?: "project_relative" | "absolute";
  lastSeenAt?: Date;
};
export async function updateWorkingCopy({
  db,
  workingCopyId,
  name,
  path,
  pathKind,
  lastSeenAt,
}: UpdateWorkingCopy): Promise<void> {
  const updated = await db
    .update(workingCopyTable)
    .set({
      ...(name !== undefined && { name }),
      ...(path !== undefined && { path }),
      ...(pathKind !== undefined && { pathKind }),
      ...(lastSeenAt !== undefined && { lastSeenAt }),
      updatedAt: sql`(unixepoch())`,
    })
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
