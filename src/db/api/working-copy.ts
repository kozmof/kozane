import { workingCopyTable } from "../schema.js";
import type { PathKind } from "../schema.js";
import { eq } from "drizzle-orm";
import type { NeedsDB, NeedsWorkingCopy, WorkingCopy } from "./types.js";
import { assertFound } from "./utils.js";

// Intentionally unscoped: working copies are tied to scopes, and scopes are
// cross-project. The UI needs all working copies to show their scope associations
// regardless of which project is currently viewed (per spec §Scopes).
export async function getAllWorkingCopies({ db }: NeedsDB): Promise<WorkingCopy[]> {
  return db.select().from(workingCopyTable);
}

type AddWorkingCopy = NeedsDB & {
  projectId?: string;
  scopeId?: string;
  name?: string;
  path?: string;
  pathKind?: PathKind;
  lastSeenAt?: Date;
};
export async function addWorkingCopy({
  db,
  scopeId,
  projectId,
  name = "",
  path,
  pathKind = "project_relative",
  lastSeenAt,
}: AddWorkingCopy): Promise<string> {
  const [row] = await db
    .insert(workingCopyTable)
    .values({
      scopeId,
      projectId,
      name,
      path,
      pathKind,
      ...(lastSeenAt !== undefined && { lastSeenAt }),
    })
    .returning({ id: workingCopyTable.id });
  return row.id;
}

type UpdateWorkingCopy = NeedsWorkingCopy & {
  name?: string;
  path?: string;
  pathKind?: PathKind;
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
      updatedAt: new Date(),
    })
    .where(eq(workingCopyTable.id, workingCopyId))
    .returning({ id: workingCopyTable.id });
  assertFound(updated, `WorkingCopy workingCopyId=${workingCopyId}`);
}

type GetWorkingCopy = NeedsWorkingCopy;
export async function getWorkingCopy({
  db,
  workingCopyId,
}: GetWorkingCopy): Promise<WorkingCopy | undefined> {
  return db.select().from(workingCopyTable).where(eq(workingCopyTable.id, workingCopyId)).get();
}

type DeleteWorkingCopy = NeedsWorkingCopy;
export async function deleteWorkingCopy({ db, workingCopyId }: DeleteWorkingCopy): Promise<void> {
  const deleted = await db
    .delete(workingCopyTable)
    .where(eq(workingCopyTable.id, workingCopyId))
    .returning({ id: workingCopyTable.id });
  assertFound(deleted, `WorkingCopy workingCopyId=${workingCopyId}`);
}
