import { taskspaceTable } from "../schema.js";
import type { PathKind } from "../schema.js";
import { and, eq, isNull, or } from "drizzle-orm";
import type { NeedsDB, NeedsNamespace, NeedsTaskspace, Taskspace } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

/**
 * Every taskspace in the workspace, whichever namespace it belongs to. The workspace-wide
 * view — `kozane taskspace list`, `kozane taskspace scan` — rather than the board's; the
 * browser asks {@link getTaskspacesInNamespace}.
 */
export async function getAllTaskspaces({ db }: NeedsDB): Promise<Taskspace[]> {
  return db.select().from(taskspaceTable);
}

/**
 * The taskspaces one namespace's board has reason to draw: its own, plus the ones assigned
 * to no namespace at all.
 *
 * `namespace_id` is nullable, and a row carrying none is unplaced rather than somebody
 * else's — see the note on `taskspaceTable` for how one gets that way. Those rows appear
 * on every board; a reattached taskspace whose marker named no namespace would otherwise be
 * invisible everywhere, with nothing in the UI able to place it.
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
 * One taskspace, but only if this namespace's board can see it — its own, or one assigned to
 * no namespace at all. Exactly the filter {@link getTaskspacesInNamespace} applies, for a
 * single row, so "shown in the panel" and "reachable through the namespace's endpoints" stay
 * the same set rather than two that happen to agree.
 *
 * The HTTP routes look a taskspace up this way rather than by id alone. That is not what
 * keeps a request inside a directory — `taskspace-files.ts` holds that boundary, and holds
 * it however the row was found — but a namespace's endpoint answering about another
 * namespace's taskspace is a surprise nothing else in the API offers.
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
  pathKind = "project_relative",
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
