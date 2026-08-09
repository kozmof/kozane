import { taskspaceTable } from "../schema.js";
import type { PathKind } from "../schema.js";
import { eq } from "drizzle-orm";
import type { NeedsDB, NeedsTaskspace, Taskspace } from "./types.js";
import { assertFound } from "./utils.js";

// Intentionally unscoped: taskspaces are tied to scopes, and scopes are
// cross-project. The UI needs all taskspaces to show their scope associations
// regardless of which project is currently viewed (per spec §Scopes).
export async function getAllTaskspaces({ db }: NeedsDB): Promise<Taskspace[]> {
  return db.select().from(taskspaceTable);
}

type AddTaskspace = NeedsDB & {
  projectId?: string;
  scopeId?: string;
  name?: string;
  path?: string;
  pathKind?: PathKind;
  lastSeenAt?: Date;
};
export async function addTaskspace({
  db,
  scopeId,
  projectId,
  name = "",
  path,
  pathKind = "project_relative",
  lastSeenAt,
}: AddTaskspace): Promise<string> {
  const [row] = await db
    .insert(taskspaceTable)
    .values({
      scopeId,
      projectId,
      name,
      path,
      pathKind,
      ...(lastSeenAt !== undefined && { lastSeenAt }),
    })
    .returning({ id: taskspaceTable.id });
  return row.id;
}

type UpdateTaskspace = NeedsTaskspace & {
  name?: string;
  path?: string;
  pathKind?: PathKind;
  lastSeenAt?: Date;
};
export async function updateTaskspace({
  db,
  taskspaceId,
  name,
  path,
  pathKind,
  lastSeenAt,
}: UpdateTaskspace): Promise<void> {
  const updated = await db
    .update(taskspaceTable)
    .set({
      ...(name !== undefined && { name }),
      ...(path !== undefined && { path }),
      ...(pathKind !== undefined && { pathKind }),
      ...(lastSeenAt !== undefined && { lastSeenAt }),
      updatedAt: new Date(),
    })
    .where(eq(taskspaceTable.id, taskspaceId))
    .returning({ id: taskspaceTable.id });
  assertFound(updated, `Taskspace taskspaceId=${taskspaceId}`);
}

type GetTaskspace = NeedsTaskspace;
export async function getTaskspace({
  db,
  taskspaceId,
}: GetTaskspace): Promise<Taskspace | undefined> {
  return db.select().from(taskspaceTable).where(eq(taskspaceTable.id, taskspaceId)).get();
}

type DeleteTaskspace = NeedsTaskspace;
export async function deleteTaskspace({ db, taskspaceId }: DeleteTaskspace): Promise<void> {
  const deleted = await db
    .delete(taskspaceTable)
    .where(eq(taskspaceTable.id, taskspaceId))
    .returning({ id: taskspaceTable.id });
  assertFound(deleted, `Taskspace taskspaceId=${taskspaceId}`);
}
