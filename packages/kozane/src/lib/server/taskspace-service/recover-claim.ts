/** Explicitly finish local database publication. Never repeat a directory claim. */
import { eq } from "drizzle-orm";
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

async function inspect(db: DB | ReadTx | Tx, root: string, operationId: string) {
  const operation = await db
    .select()
    .from(localFileOperationTable)
    .where(eq(localFileOperationTable.id, operationId))
    .get();
  if (!operation) throw new Error("Local directory claim not found");
  if (operation.kind !== "taskspace.claim")
    throw new Error("This operation is not a directory claim");
  if (operation.state === "confirmed")
    return { operation, status: "already-confirmed" as const, reason: null };
  const observation = inspectLocalClaim(operation, root);
  if (observation !== "matching-marker")
    return { operation, status: "blocked" as const, reason: observation };
  const shared = await db
    .select()
    .from(taskspaceTable)
    .where(eq(taskspaceTable.id, operation.taskspaceId))
    .get();
  if (!shared)
    return { operation, status: "blocked" as const, reason: "Taskspace no longer exists" };
  if (shared.namespaceId !== operation.namespaceId)
    return { operation, status: "blocked" as const, reason: "Taskspace namespace has changed" };
  const namespace = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, operation.namespaceId))
    .get();
  if (!namespace)
    return { operation, status: "blocked" as const, reason: "Namespace no longer exists" };
  const attachment = await db
    .select()
    .from(taskspaceLocalTable)
    .where(eq(taskspaceLocalTable.taskspaceId, operation.taskspaceId))
    .get();
  if (
    attachment?.path != null &&
    (attachment.path !== operation.path || attachment.pathKind !== operation.pathKind)
  )
    return {
      operation,
      status: "blocked" as const,
      reason: "Taskspace already has a different directory",
    };
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
        .where(eq(localFileOperationTable.id, operationId))
        .returning();
      if (confirmed.length !== 1) throw new Error("Directory claim intent is missing");
      return { operation: confirmed[0], status: "confirmed" as const, reason: null };
    }),
  );
}
