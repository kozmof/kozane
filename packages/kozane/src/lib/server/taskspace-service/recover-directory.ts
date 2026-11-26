/** Finish verified database publication after completed directory work. Never repeat disk work. */
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import { getNamespace } from "../../../db/api/namespace.js";
import {
  updateTaskspace,
  updateTaskspaceLocationInTx,
  deleteTaskspaceInTx,
} from "../../../db/api/taskspace.js";
import {
  cardTable,
  localFileOperationTable,
  taskspaceTable,
  taskspaceLocalTable,
} from "../../../db/schema.js";
import type { PathKind } from "../../constants.js";
import { inspectTaskspaceDirectoryOperation } from "../taskspace-directory-operations.js";
import { taskspaceDirectorySnapshot } from "./directory-operation.js";
import { oneAtATime } from "./queue.js";

type Operation = typeof localFileOperationTable.$inferSelect;
type Before = ReturnType<typeof taskspaceDirectorySnapshot>;
type Intent = { before: Before } & (
  | { operation: "remove" }
  | { operation: "move"; name: string; targetPath: string }
  | { operation: "layout"; targetPath: string }
);

function intentIdentity(operation: Operation) {
  return and(
    eq(localFileOperationTable.id, operation.id),
    eq(localFileOperationTable.kind, "taskspace.directory"),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.taskspaceId, operation.taskspaceId),
    eq(localFileOperationTable.namespaceId, operation.namespaceId),
    eq(localFileOperationTable.path, operation.path),
    eq(localFileOperationTable.pathKind, operation.pathKind),
    eq(localFileOperationTable.intent, operation.intent),
    eq(localFileOperationTable.createdAt, operation.createdAt),
  );
}

/** Version 1 needs shared timestamps, but local observations are outside its snapshot. */
async function sharedSnapshot(db: ReadTx | Tx, taskspaceId: string) {
  const row = await db
    .select({
      ...getTableColumns(taskspaceTable),
      path: taskspaceLocalTable.path,
      pathKind: sql<PathKind>`coalesce(${taskspaceLocalTable.pathKind}, 'workspace_relative')`,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id))
    .where(eq(taskspaceTable.id, taskspaceId))
    .get();
  return row && taskspaceDirectorySnapshot(row);
}

/** Preserve bytes and storage class, with a separate REAL value to avoid text rounding. */
function attachment(db: ReadTx | Tx, taskspaceId: string) {
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

function sameSnapshot(actual: Before, expected: Before) {
  return (Object.keys(expected) as (keyof Before)[]).every((key) => actual[key] === expected[key]);
}

function diskIssue(operation: Operation, intent: Intent, root: string) {
  const observation = inspectTaskspaceDirectoryOperation(operation, root);
  return observation === (intent.operation === "remove" ? "source-absent" : "target-only")
    ? null
    : `Directory work is not verified as complete: ${observation}`;
}

/** Disk inspection separately validates paths, marker identity and the complete intent shape. */
function recoveryIntent(operation: Operation): Intent | null {
  try {
    const intent = JSON.parse(operation.intent);
    const before = intent?.before;
    if (!before || typeof before !== "object" || Array.isArray(before)) return null;
    const fields = [
      "id",
      "namespaceId",
      "scopeId",
      "name",
      "path",
      "pathKind",
      "createdAt",
      "updatedAt",
    ];
    if (
      Object.keys(before).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(before, field)) ||
      before.id !== operation.taskspaceId ||
      before.path !== operation.path ||
      before.pathKind !== "workspace_relative" ||
      (before.namespaceId !== null && before.namespaceId !== operation.namespaceId) ||
      (before.scopeId !== null && typeof before.scopeId !== "string") ||
      typeof before.name !== "string" ||
      !Number.isSafeInteger(before.createdAt) ||
      !Number.isSafeInteger(before.updatedAt)
    )
      return null;
    switch (intent.operation) {
      case "remove":
        return intent as Intent;
      case "move":
        if (typeof intent.name !== "string") return null;
      // fall through: both move forms require a recorded destination.
      case "layout":
        return typeof intent.targetPath === "string" ? (intent as Intent) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function inspect(db: ReadTx | Tx, root: string, operationId: string) {
  const operation = await db
    .select()
    .from(localFileOperationTable)
    .where(eq(localFileOperationTable.id, operationId))
    .get();
  if (!operation) throw new Error("Local directory operation not found");
  if (operation.kind !== "taskspace.directory")
    throw new Error("This operation is not a directory mutation");
  if (operation.state === "abandoned") throw new Error("This directory operation was abandoned");
  const blocked = (reason: string) => ({
    operation,
    status: "blocked" as const,
    reason,
    intent: null,
  });
  if (operation.state === "confirmed")
    return { operation, status: "already-confirmed" as const, reason: null, intent: null };
  if (operation.error !== null)
    return blocked(
      "A filesystem failure was recorded. Review and repair disk state, then abandon tracking",
    );
  const intent = recoveryIntent(operation);
  if (!intent) return blocked("Invalid recorded taskspace snapshot");
  const current = await sharedSnapshot(db, operation.taskspaceId);
  if (!current) return blocked("Taskspace no longer exists");
  if (!(await getNamespace({ db, namespaceId: operation.namespaceId })))
    return blocked("Namespace no longer exists");
  if (!sameSnapshot(current, intent.before))
    return blocked("Taskspace or attachment changed since the operation was recorded");
  const issue = diskIssue(operation, intent, root);
  if (issue !== null) return blocked(issue);
  return { operation, status: "confirmable" as const, reason: null, intent };
}

export async function recoverDirectoryOperation(
  db: DB,
  root: string,
  operationId: string,
  apply = false,
) {
  if (!apply) return withReadTx(db, (tx) => inspect(tx, root, operationId));
  const identity = await withReadTx(db, (tx) =>
    tx
      .select({ taskspaceId: localFileOperationTable.taskspaceId })
      .from(localFileOperationTable)
      .where(eq(localFileOperationTable.id, operationId))
      .get(),
  );
  if (!identity) throw new Error("Local directory operation not found");
  return oneAtATime(identity.taskspaceId, () =>
    withTx(db, async (tx) => {
      const current = await inspect(tx, root, operationId);
      if (current.operation.taskspaceId !== identity.taskspaceId)
        throw new Error("Directory operation identity changed");
      if (current.status === "already-confirmed") return current;
      if (current.status === "blocked")
        throw new Error(`Directory operation cannot be confirmed: ${current.reason}`);
      const { operation, intent } = current;
      const beforeAttachment = await attachment(tx, operation.taskspaceId);
      if (!beforeAttachment) throw new Error("Directory attachment is missing");
      const expectedShared = { ...intent.before };
      const expectedAttachment = { ...beforeAttachment };
      switch (intent.operation) {
        case "move": {
          await updateTaskspace({
            db: tx,
            taskspaceId: operation.taskspaceId,
            name: intent.name,
            path: intent.targetPath,
          });
          expectedShared.name = intent.name;
          expectedShared.path = intent.targetPath;
          expectedAttachment.path = intent.targetPath;
          // Keep the service's resulting label clock for verification after journal triggers.
          const updated = await tx
            .select({ updatedAt: taskspaceTable.updatedAt })
            .from(taskspaceTable)
            .where(eq(taskspaceTable.id, operation.taskspaceId))
            .get();
          if (!updated) throw new Error("Taskspace disappeared during directory recovery");
          expectedShared.updatedAt = updated.updatedAt.getTime();
          break;
        }
        case "layout":
          await updateTaskspaceLocationInTx({
            db: tx,
            taskspaceId: operation.taskspaceId,
            path: intent.targetPath,
          });
          expectedShared.path = intent.targetPath;
          expectedAttachment.path = intent.targetPath;
          break;
        case "remove":
          await deleteTaskspaceInTx({ db: tx, taskspaceId: operation.taskspaceId });
      }
      const now = new Date();
      const [confirmed] = await tx
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt: now })
        .where(
          and(
            intentIdentity(operation),
            eq(localFileOperationTable.state, "pending"),
            isNull(localFileOperationTable.error),
          ),
        )
        .returning();
      if (!confirmed) throw new Error("Directory operation intent changed or is missing");
      // RETURNING precedes AFTER triggers. Verify the receipt and published state before commit.
      const receipt = await tx
        .select({ id: localFileOperationTable.id })
        .from(localFileOperationTable)
        .where(
          and(
            intentIdentity(operation),
            eq(localFileOperationTable.state, "confirmed"),
            eq(localFileOperationTable.confirmedAt, now),
            isNull(localFileOperationTable.error),
          ),
        )
        .get();
      if (!receipt) throw new Error("Directory operation confirmation changed or is missing");
      if (!(await getNamespace({ db: tx, namespaceId: operation.namespaceId })))
        throw new Error("Directory operation namespace no longer exists");
      const published = await sharedSnapshot(tx, operation.taskspaceId);
      if (intent.operation === "remove") {
        const linked = await tx
          .select({ id: cardTable.id })
          .from(cardTable)
          .where(eq(cardTable.taskspaceId, operation.taskspaceId))
          .get();
        if (published || linked) throw new Error("Directory removal database state changed");
      } else if (!published || !sameSnapshot(published, expectedShared)) {
        throw new Error("Directory recovery taskspace or attachment changed");
      }
      const finalAttachment = await attachment(tx, operation.taskspaceId);
      if (
        !finalAttachment ||
        (Object.keys(expectedAttachment) as (keyof typeof expectedAttachment)[]).some(
          (key) => !Object.is(finalAttachment[key], expectedAttachment[key]),
        )
      )
        throw new Error("Directory recovery attachment changed or is missing");
      const issue = diskIssue(operation, intent, root);
      if (issue !== null) throw new Error(`Directory operation cannot be confirmed: ${issue}`);
      return { operation: confirmed, status: "confirmed" as const, reason: null, intent };
    }),
  );
}
