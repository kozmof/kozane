import { taskspaceTable, taskspaceLocalTable } from "../schema.js";
import type { PathKind } from "../schema.js";
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import { withTx, type Tx } from "../database.js";
import { isDatabaseHandle } from "../database-handles.js";
import { boundEntityId, boundTaskspaceTimestamp } from "../actions/allocations.js";
import { withActionService } from "../actions/service-frame.js";
import type {
  ReadsNamespace,
  NeedsDB,
  NeedsNamespace,
  NeedsTaskspace,
  Taskspace,
  TaskspaceLocal,
  NeedsReader,
  NeedsTx,
} from "../database-types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";

function taskspaceRows(db: NeedsReader["db"]) {
  return db
    .select({
      ...getTableColumns(taskspaceTable),
      path: taskspaceLocalTable.path,
      pathKind: sql<PathKind>`coalesce(${taskspaceLocalTable.pathKind}, 'workspace_relative')`,
      lastSeenAt: taskspaceLocalTable.lastSeenAt,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id));
}

/** Multi-table compatibility writes open one boundary or reuse their caller's transaction. */
function write<T>(db: NeedsDB["db"], operation: (tx: Tx) => Promise<T>): Promise<T> {
  return isDatabaseHandle(db)
    ? withTx(db, (tx) => withActionService(tx, () => operation(tx)))
    : withActionService(db, () => operation(db));
}

/** Includes retained attachments whose shared taskspace is currently absent. */
export function getAllTaskspaceLocalMetadata({ db }: NeedsReader): Promise<TaskspaceLocal[]> {
  return db.select().from(taskspaceLocalTable);
}

/**
 * List every workspace taskspace for CLI listing and scanning. Use {@link
 * getTaskspacesInNamespace} for board data.
 */
export async function getAllTaskspaces({ db }: NeedsReader): Promise<Taskspace[]> {
  return taskspaceRows(db);
}

/**
 * List taskspaces assigned to this namespace and unplaced taskspaces, which appear on every
 * board.
 */
export async function getTaskspacesInNamespace({
  db,
  namespaceId,
}: ReadsNamespace): Promise<Taskspace[]> {
  return taskspaceRows(db).where(
    or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)),
  );
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
  return taskspaceRows(db)
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
  return write(input.db, (tx) => insertTaskspace({ ...input, db: tx }));
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
  pathKind,
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
      ...(timestamp !== undefined && { createdAt: timestamp, updatedAt: timestamp }),
    })
    .returning({ id: taskspaceTable.id });
  if (path !== undefined || pathKind !== undefined || lastSeenAt !== undefined) {
    await db
      .insert(taskspaceLocalTable)
      .values({ taskspaceId: row.id, path, pathKind, lastSeenAt });
  }
  return row.id;
}

type UpdateTaskspace = NeedsTaskspace & {
  name?: string;
  path?: string | null;
  pathKind?: PathKind;
  lastSeenAt?: Date | null;
};
export function updateTaskspace(input: UpdateTaskspace): Promise<void> {
  return write(input.db, (tx) => writeTaskspace({ ...input, db: tx }));
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
  if (name === undefined) {
    const found = await db
      .select({ id: taskspaceTable.id })
      .from(taskspaceTable)
      .where(eq(taskspaceTable.id, taskspaceId));
    assertFound(found, `Taskspace taskspaceId=${taskspaceId}`);
  }
  const timestamp =
    name === undefined ? undefined : boundTaskspaceTimestamp(db, "update", taskspaceId);
  const seconds =
    name === undefined
      ? undefined
      : timestamp === undefined
        ? Math.floor(Date.now() / 1000)
        : timestamp.getTime() / 1000;
  if (name !== undefined) {
    const updated = await db
      .update(taskspaceTable)
      .set({
        name,
        updatedAt: sql`CASE WHEN ${taskspaceTable.name} <> ${name} THEN ${seconds} ELSE ${taskspaceTable.updatedAt} END`,
      })
      .where(eq(taskspaceTable.id, taskspaceId))
      .returning({ id: taskspaceTable.id });
    assertFound(updated, `Taskspace taskspaceId=${taskspaceId}`);
  }
  if (path !== undefined || pathKind !== undefined || lastSeenAt !== undefined) {
    const fields = {
      ...(path !== undefined && { path }),
      ...(pathKind !== undefined && { pathKind }),
      ...(lastSeenAt !== undefined && { lastSeenAt }),
    };
    const current = await db
      .select({ id: taskspaceLocalTable.taskspaceId })
      .from(taskspaceLocalTable)
      .where(eq(taskspaceLocalTable.taskspaceId, taskspaceId))
      .get();
    if (current)
      await db
        .update(taskspaceLocalTable)
        .set(fields)
        .where(eq(taskspaceLocalTable.taskspaceId, taskspaceId));
    else await db.insert(taskspaceLocalTable).values({ taskspaceId, ...fields });
  }
}

type GetTaskspace = NeedsReader & { taskspaceId: string };
export async function getTaskspace({
  db,
  taskspaceId,
}: GetTaskspace): Promise<Taskspace | undefined> {
  return taskspaceRows(db).where(eq(taskspaceTable.id, taskspaceId)).get();
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
