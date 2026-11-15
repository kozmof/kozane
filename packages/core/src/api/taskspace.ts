import { taskspaceTable } from "../schema.js";
import type { PathKind } from "../schema.js";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { boundEntityId, boundTaskspaceTimestamp } from "../actions/allocations.js";
import { withActionService } from "../actions/service-frame.js";
import type {
  ReadsNamespace,
  NeedsDB,
  NeedsNamespace,
  NeedsTaskspace,
  Taskspace,
  NeedsReader,
  NeedsTx,
} from "../database-types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

/**
 * List every workspace taskspace for CLI listing and scanning. Use {@link
 * getTaskspacesInNamespace} for board data.
 */
export async function getAllTaskspaces({ db }: NeedsReader): Promise<Taskspace[]> {
  return db.select().from(taskspaceTable);
}

/**
 * List taskspaces assigned to this namespace and unplaced taskspaces, which appear on every
 * board.
 */
export async function getTaskspacesInNamespace({
  db,
  namespaceId,
}: ReadsNamespace): Promise<Taskspace[]> {
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
export function addTaskspace(input: AddTaskspace): Promise<string> {
  return withActionService(input.db, () => insertTaskspace(input));
}

/** Create database identity and placement without attaching a local directory. */
export function addTaskspaceInTx(
  input: NeedsTx & Pick<AddTaskspace, "namespaceId" | "scopeId" | "name">,
): Promise<string> {
  const { db, namespaceId, scopeId, name } = input;
  return addTaskspace({ db, namespaceId, scopeId, name });
}

async function insertTaskspace({
  db,
  scopeId,
  namespaceId,
  name = "",
  path,
  pathKind = "workspace_relative",
  lastSeenAt,
}: AddTaskspace): Promise<string> {
  assertNameWithinLimit(name, "Taskspace name");
  const timestamp = boundTaskspaceTimestamp(db, "create");
  const [row] = await db
    .insert(taskspaceTable)
    .values({
      id: boundEntityId(db, "taskspace"),
      scopeId,
      namespaceId,
      name,
      path,
      pathKind,
      ...(lastSeenAt !== undefined && { lastSeenAt }),
      ...(timestamp !== undefined && { createdAt: timestamp, updatedAt: timestamp }),
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
export function updateTaskspace(input: UpdateTaskspace): Promise<void> {
  return withActionService(input.db, () => writeTaskspace(input));
}

/** Change the label without moving directories or updating local observations. */
export function updateTaskspaceName({
  db,
  taskspaceId,
  name,
}: NeedsTaskspace & { name: string }): Promise<void> {
  return updateTaskspace({ db, taskspaceId, name });
}

export function updateTaskspaceNameInTx(
  input: NeedsTx & { taskspaceId: string; name: string },
): Promise<void> {
  return updateTaskspaceName(input);
}

type UpdateTaskspaceLocation = NeedsTaskspace &
  Pick<UpdateTaskspace, "path" | "pathKind" | "lastSeenAt">;

/** Local path and observation changes preserve the shared label's timestamp. */
export function updateTaskspaceLocation({
  db,
  taskspaceId,
  path,
  pathKind,
  lastSeenAt,
}: UpdateTaskspaceLocation): Promise<void> {
  return updateTaskspace({ db, taskspaceId, path, pathKind, lastSeenAt });
}

export function updateTaskspaceLocationInTx(
  input: Omit<UpdateTaskspaceLocation, "db"> & NeedsTx,
): Promise<void> {
  return updateTaskspaceLocation(input);
}

async function writeTaskspace({
  db,
  taskspaceId,
  name,
  path,
  pathKind,
  lastSeenAt,
}: UpdateTaskspace): Promise<void> {
  if (name !== undefined) assertNameWithinLimit(name, "Taskspace name");
  if (
    name === undefined &&
    path === undefined &&
    pathKind === undefined &&
    lastSeenAt === undefined
  ) {
    const found = await db
      .select({ id: taskspaceTable.id })
      .from(taskspaceTable)
      .where(eq(taskspaceTable.id, taskspaceId));
    assertFound(found, `Taskspace taskspaceId=${taskspaceId}`);
    return;
  }
  const timestamp =
    name === undefined ? undefined : boundTaskspaceTimestamp(db, "update", taskspaceId);
  const seconds =
    name === undefined
      ? undefined
      : timestamp === undefined
        ? Math.floor(Date.now() / 1000)
        : timestamp.getTime() / 1000;
  const updated = await db
    .update(taskspaceTable)
    .set({
      ...(name !== undefined && { name }),
      ...(path !== undefined && { path }),
      ...(pathKind !== undefined && { pathKind }),
      ...(lastSeenAt !== undefined && { lastSeenAt }),
      ...(name !== undefined && {
        updatedAt: sql`CASE WHEN ${taskspaceTable.name} <> ${name} THEN ${seconds} ELSE ${taskspaceTable.updatedAt} END`,
      }),
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
export function deleteTaskspace({ db, taskspaceId }: DeleteTaskspace): Promise<void> {
  return withActionService(db, async () => {
    const deleted = await db
      .delete(taskspaceTable)
      .where(eq(taskspaceTable.id, taskspaceId))
      .returning({ id: taskspaceTable.id });
    assertFound(deleted, `Taskspace taskspaceId=${taskspaceId}`);
  });
}

export function deleteTaskspaceInTx(input: NeedsTx & { taskspaceId: string }): Promise<void> {
  return deleteTaskspace(input);
}
