import { taskspaceTable } from "../schema.js";
import type { PathKind } from "../schema.js";
import { and, eq, isNull, or } from "drizzle-orm";
import type { NeedsDB, NeedsNamespace, NeedsTaskspace, Taskspace } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

/**
 * List every workspace taskspace for CLI listing and scanning. Use {@link
 * getTaskspacesInNamespace} for board data.
 */
export async function getAllTaskspaces({ db }: NeedsDB): Promise<Taskspace[]> {
  return db.select().from(taskspaceTable);
}

/**
 * List taskspaces assigned to this namespace and unplaced taskspaces, which appear on every
 * board.
 */
export async function getTaskspacesInNamespace({
  db,
  namespaceId,
}: NeedsNamespace): Promise<Taskspace[]> {
  return db
    .select()
    .from(taskspaceTable)
    .where(or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)));
}

type GetTaskspaceInNamespace = NeedsNamespace & { taskspaceId: string };

/**
 * Find one taskspace visible to this namespace using the same ownership rule as the board
 * listing. Filesystem helpers separately enforce path containment.
 */
export async function getTaskspaceInNamespace({
  db,
  namespaceId,
  taskspaceId,
}: GetTaskspaceInNamespace): Promise<Taskspace | undefined> {
  return db
    .select()
    .from(taskspaceTable)
    .where(
      and(
        eq(taskspaceTable.id, taskspaceId),
        or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)),
      ),
    )
    .get();
}

type AddTaskspace = NeedsDB & {
  namespaceId?: string;
  scopeId?: string;
  name?: string;
  path?: string;
  pathKind?: PathKind;
  lastSeenAt?: Date;
};
export async function addTaskspace({
  db,
  scopeId,
  namespaceId,
  name = "",
  path,
  pathKind = "workspace_relative",
  lastSeenAt,
}: AddTaskspace): Promise<string> {
  assertNameWithinLimit(name, "Taskspace name");
  const [row] = await db
    .insert(taskspaceTable)
    .values({
      scopeId,
      namespaceId,
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
  if (name !== undefined) assertNameWithinLimit(name, "Taskspace name");
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
