/** Explicitly finish local database publication. Never repeat a directory claim. */
import { and, eq, isNull } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import {
  localFileOperationTable,
  namespaceTable,
  taskspaceLocalTable,
  taskspaceTable,
} from "../../../db/schema.js";
import { updateTaskspaceLocationInTx } from "../../../db/api/taskspace.js";
import { inspectLocalClaim } from "../local-file-operations.js";
import { oneAtATime } from "./queue.js";

type Operation = typeof localFileOperationTable.$inferSelect;

function intentIdentity(operation: Operation) {
  return and(
    eq(localFileOperationTable.id, operation.id),
    eq(localFileOperationTable.kind, "taskspace.claim"),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.taskspaceId, operation.taskspaceId),
    eq(localFileOperationTable.namespaceId, operation.namespaceId),
    eq(localFileOperationTable.path, operation.path),
    eq(localFileOperationTable.pathKind, operation.pathKind),
    eq(localFileOperationTable.intent, operation.intent),
    eq(localFileOperationTable.createdAt, operation.createdAt),
  );
}

/** Read only fields needed to attach. Shared timestamps and earlier observations stay opaque. */
async function targetIssue(db: ReadTx | Tx, operation: Operation) {
  const shared = await db
    .select({ namespaceId: taskspaceTable.namespaceId })
    .from(taskspaceTable)
    .where(eq(taskspaceTable.id, operation.taskspaceId))
    .get();
  if (!shared) return "Taskspace no longer exists";
  if (shared.namespaceId !== operation.namespaceId) return "Taskspace namespace has changed";
  const namespace = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, operation.namespaceId))
    .get();
  if (!namespace) return "Namespace no longer exists";
  const attachment = await db
    .select({ path: taskspaceLocalTable.path, pathKind: taskspaceLocalTable.pathKind })
    .from(taskspaceLocalTable)
    .where(eq(taskspaceLocalTable.taskspaceId, operation.taskspaceId))
    .get();
  if (
    attachment?.path != null &&
    (attachment.path !== operation.path || attachment.pathKind !== operation.pathKind)
  )
    return "Taskspace already has a different directory";
  return null;
}

async function inspect(db: ReadTx | Tx, root: string, operationId: string) {
  const operation = await db
    .select()
    .from(localFileOperationTable)
    .where(eq(localFileOperationTable.id, operationId))
    .get();
  if (!operation) throw new Error("Local directory claim not found");
  if (operation.kind !== "taskspace.claim")
    throw new Error("This operation is not a directory claim");
  if (operation.state === "abandoned") throw new Error("This directory claim was abandoned");
  if (operation.state === "confirmed")
    return { operation, status: "already-confirmed" as const, reason: null };
  const observation = inspectLocalClaim(operation, root);
  if (observation !== "matching-marker")
    return { operation, status: "blocked" as const, reason: observation };
  const reason = await targetIssue(db, operation);
  if (reason !== null) return { operation, status: "blocked" as const, reason };
  return { operation, status: "confirmable" as const, reason: null };
}

/** Preview is read-only. Apply repeats every check inside its serialized write transaction. */
export async function recoverLocalClaim(db: DB, root: string, operationId: string, apply = false) {
  if (!apply) return withReadTx(db, (tx) => inspect(tx, root, operationId));
  const identity = await withReadTx(db, (tx) =>
    tx
      .select({ taskspaceId: localFileOperationTable.taskspaceId })
      .from(localFileOperationTable)
      .where(eq(localFileOperationTable.id, operationId))
      .get(),
  );
  if (!identity) throw new Error("Local directory claim not found");
  return oneAtATime(identity.taskspaceId, () =>
    withTx(db, async (tx) => {
      const current = await inspect(tx, root, operationId);
      if (current.operation.taskspaceId !== identity.taskspaceId)
        throw new Error("Directory claim identity changed");
      if (current.status === "already-confirmed") return current;
      if (current.status === "blocked")
        throw new Error(`Directory claim cannot be confirmed: ${current.reason}`);
      const { operation } = current;
      const now = new Date();
      await updateTaskspaceLocationInTx({
        db: tx,
        taskspaceId: operation.taskspaceId,
        path: operation.path,
        pathKind: operation.pathKind,
        lastSeenAt: now,
      });
      const confirmed = await tx
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt: now, error: null })
        .where(
          and(
            intentIdentity(operation),
            eq(localFileOperationTable.state, "pending"),
            operation.error === null
              ? isNull(localFileOperationTable.error)
              : eq(localFileOperationTable.error, operation.error),
          ),
        )
        .returning();
      if (confirmed.length !== 1) throw new Error("Directory claim intent changed or is missing");
      // RETURNING precedes AFTER triggers. Verify the final receipt and attachment before commit.
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
      if (!receipt) throw new Error("Directory claim confirmation changed or is missing");
      const issue = await targetIssue(tx, operation);
      if (issue !== null) throw new Error(`Directory claim cannot be confirmed: ${issue}`);
      const attachment = await tx
        .select({ taskspaceId: taskspaceLocalTable.taskspaceId })
        .from(taskspaceLocalTable)
        .where(
          and(
            eq(taskspaceLocalTable.taskspaceId, operation.taskspaceId),
            eq(taskspaceLocalTable.path, operation.path),
            eq(taskspaceLocalTable.pathKind, operation.pathKind),
            eq(taskspaceLocalTable.lastSeenAt, now),
          ),
        )
        .get();
      if (!attachment) throw new Error("Directory claim attachment changed or is missing");
      return { operation: confirmed[0], status: "confirmed" as const, reason: null };
    }),
  );
}
