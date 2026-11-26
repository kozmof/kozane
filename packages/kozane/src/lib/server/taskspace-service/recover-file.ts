/** Confirm an explicitly reviewed file outcome without repeating filesystem work. */
import { and, eq, isNull } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import {
  localFileOperationTable,
  namespaceTable,
  taskspaceTable,
  taskspaceLocalTable,
} from "../../../db/schema.js";
import {
  inspectTaskspaceFileRecovery,
  parseTaskspaceFileIntent,
} from "../taskspace-file-operations.js";
import { resolveTaskspacePath } from "../taskspace-path.js";
import { oneAtATime } from "./queue.js";

type Operation = typeof localFileOperationTable.$inferSelect;
type Intent = NonNullable<ReturnType<typeof parseTaskspaceFileIntent>>;

function intentIdentity(operation: Operation) {
  return and(
    eq(localFileOperationTable.id, operation.id),
    eq(localFileOperationTable.kind, "taskspace.file"),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.taskspaceId, operation.taskspaceId),
    eq(localFileOperationTable.namespaceId, operation.namespaceId),
    eq(localFileOperationTable.path, operation.path),
    eq(localFileOperationTable.pathKind, operation.pathKind),
    eq(localFileOperationTable.intent, operation.intent),
    eq(localFileOperationTable.createdAt, operation.createdAt),
  );
}

/** Eligibility needs namespace and path fields, without decoding unrelated timestamps. */
async function outcomeIssue(db: ReadTx | Tx, root: string, operation: Operation, intent: Intent) {
  const taskspace = await db
    .select({
      namespaceId: taskspaceTable.namespaceId,
      path: taskspaceLocalTable.path,
      pathKind: taskspaceLocalTable.pathKind,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id))
    .where(eq(taskspaceTable.id, operation.taskspaceId))
    .get();
  if (!taskspace) return "Taskspace no longer exists";
  const namespace = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, operation.namespaceId))
    .get();
  if (!namespace) return "Namespace no longer exists";
  if (taskspace.namespaceId !== null && taskspace.namespaceId !== operation.namespaceId)
    return "Taskspace is no longer visible in the recorded namespace";
  const base =
    taskspace.path &&
    taskspace.pathKind &&
    resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
  if (!base) return "Taskspace has no valid directory attachment";
  const observation = inspectTaskspaceFileRecovery(operation, root, base);
  const expected = {
    "create-file": "matching-content",
    "save-file": "matching-content",
    "create-directory": "directory-present",
    "rename-entry": "target-only",
    "remove-entry": "entry-absent",
  }[intent.operation];
  return observation === expected ? null : `File outcome is not verified: ${observation}`;
}

async function inspect(db: ReadTx | Tx, root: string, operationId: string) {
  const operation = await db
    .select()
    .from(localFileOperationTable)
    .where(eq(localFileOperationTable.id, operationId))
    .get();
  if (!operation) throw new Error("Local file operation not found");
  if (operation.kind !== "taskspace.file") throw new Error("This operation is not a file mutation");
  if (operation.state === "abandoned") throw new Error("This file operation was abandoned");
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
  const intent = parseTaskspaceFileIntent(operation);
  if (!intent) return blocked("Invalid recorded file intent");
  const reason = await outcomeIssue(db, root, operation, intent);
  if (reason !== null) return blocked(reason);
  return { operation, status: "confirmable" as const, reason: null, intent };
}

/** Preview is read-only. Applying rechecks evidence after acquiring the taskspace queue. */
export async function recoverFileOperation(
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
  if (!identity) throw new Error("Local file operation not found");
  return oneAtATime(identity.taskspaceId, () =>
    withTx(db, async (tx) => {
      const current = await inspect(tx, root, operationId);
      if (current.operation.taskspaceId !== identity.taskspaceId)
        throw new Error("File operation identity changed");
      if (current.status === "already-confirmed") return current;
      if (current.status === "blocked")
        throw new Error(`File operation cannot be confirmed: ${current.reason}`);
      const { operation, intent } = current;
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
      if (!confirmed) throw new Error("File operation intent changed or is missing");
      // RETURNING precedes AFTER triggers. Check the final receipt and live outcome before commit.
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
      if (!receipt) throw new Error("File operation confirmation changed or is missing");
      const reason = await outcomeIssue(tx, root, operation, intent);
      if (reason !== null) throw new Error(`File operation cannot be confirmed: ${reason}`);
      return { operation: confirmed, status: "confirmed" as const, reason: null, intent };
    }),
  );
}
