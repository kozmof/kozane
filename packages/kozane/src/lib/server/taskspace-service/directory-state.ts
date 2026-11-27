/** Shared row and retained local state checks for directory publication and recovery. */
import { and, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { AnyDB, ReadTx, Tx } from "../../../db/database.js";
import {
  cardTable,
  namespaceTable,
  taskspaceTable,
  taskspaceLocalTable,
} from "../../../db/schema.js";
import type { PathKind } from "../../constants.js";
import { TaskspaceFilesError } from "../taskspace-files.js";

type Row = typeof taskspaceTable.$inferSelect & { path: string | null; pathKind: PathKind };
export function taskspaceDirectorySnapshot(record: Row) {
  if (
    !Number.isSafeInteger(record.createdAt.getTime()) ||
    !Number.isSafeInteger(record.updatedAt.getTime())
  )
    throw new TaskspaceFilesError("stale", "Taskspace timestamps cannot be recorded safely");
  return {
    id: record.id,
    namespaceId: record.namespaceId,
    scopeId: record.scopeId,
    name: record.name,
    path: record.path,
    pathKind: record.pathKind,
    createdAt: record.createdAt.getTime(),
    updatedAt: record.updatedAt.getTime(),
  };
}
export type DirectorySnapshot = ReturnType<typeof taskspaceDirectorySnapshot>;

/** Directory operations need shared fields and paths, but never decode local observations. */
export function readDirectoryTaskspace(db: AnyDB, taskspaceId: string, namespaceId?: string) {
  return db
    .select({
      ...getTableColumns(taskspaceTable),
      path: taskspaceLocalTable.path,
      pathKind: sql<PathKind>`coalesce(${taskspaceLocalTable.pathKind}, 'workspace_relative')`,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id))
    .where(
      and(
        eq(taskspaceTable.id, taskspaceId),
        namespaceId === undefined
          ? undefined
          : or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)),
      ),
    )
    .get();
}

/** Version 1 needs shared timestamps, but local observations stay outside its snapshot. */
export async function readDirectorySnapshot(db: ReadTx | Tx, taskspaceId: string) {
  const row = await readDirectoryTaskspace(db, taskspaceId);
  return row && taskspaceDirectorySnapshot(row);
}

/** Preserve bytes and storage class, with a separate REAL value to avoid text rounding. */
export function readDirectoryAttachment(db: ReadTx | Tx, taskspaceId: string) {
  return db
    .select({
      taskspaceId: taskspaceLocalTable.taskspaceId,
      path: taskspaceLocalTable.path,
      pathKind: taskspaceLocalTable.pathKind,
      observationBytes: sql<string>`hex(${taskspaceLocalTable.lastSeenAt})`,
      observationType: sql<string>`typeof(${taskspaceLocalTable.lastSeenAt})`,
      observationReal: sql<
        number | null
      >`CASE WHEN typeof(${taskspaceLocalTable.lastSeenAt}) = 'real' THEN ${taskspaceLocalTable.lastSeenAt} ELSE NULL END`,
    })
    .from(taskspaceLocalTable)
    .where(eq(taskspaceLocalTable.taskspaceId, taskspaceId))
    .get();
}
export type DirectoryAttachment = NonNullable<Awaited<ReturnType<typeof readDirectoryAttachment>>>;

export function sameDirectorySnapshot(actual: DirectorySnapshot, expected: DirectorySnapshot) {
  return (Object.keys(expected) as (keyof DirectorySnapshot)[]).every(
    (key) => actual[key] === expected[key],
  );
}

export async function verifyDirectoryPublication(
  db: ReadTx | Tx,
  namespaceId: string,
  operation: "move" | "layout" | "remove",
  expected: DirectorySnapshot,
  attachment: DirectoryAttachment,
) {
  const namespace = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, namespaceId))
    .get();
  if (!namespace) throw new Error("Directory operation namespace no longer exists");
  const published = await readDirectorySnapshot(db, expected.id);
  if (operation === "remove") {
    const linked = await db
      .select({ id: cardTable.id })
      .from(cardTable)
      .where(eq(cardTable.taskspaceId, expected.id))
      .get();
    if (published || linked) throw new Error("Directory removal database state changed");
  } else if (!published || !sameDirectorySnapshot(published, expected)) {
    throw new Error("Directory publication taskspace or attachment changed");
  }
  const finalAttachment = await readDirectoryAttachment(db, expected.id);
  if (
    !finalAttachment ||
    (Object.keys(attachment) as (keyof DirectoryAttachment)[]).some(
      (key) => !Object.is(finalAttachment[key], attachment[key]),
    )
  )
    throw new Error("Directory publication attachment changed or is missing");
}
