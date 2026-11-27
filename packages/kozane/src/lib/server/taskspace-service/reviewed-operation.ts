import { and, eq, isNull, or } from "drizzle-orm";
import type { Tx } from "../../../db/database.js";
import { localFileOperationTable } from "../../../db/schema.js";

type Operation = typeof localFileOperationTable.$inferSelect;

function operationIdentity(operation: Operation) {
  return and(
    eq(localFileOperationTable.id, operation.id),
    eq(localFileOperationTable.kind, operation.kind),
    eq(localFileOperationTable.version, operation.version),
    eq(localFileOperationTable.taskspaceId, operation.taskspaceId),
    eq(localFileOperationTable.namespaceId, operation.namespaceId),
    eq(localFileOperationTable.path, operation.path),
    eq(localFileOperationTable.pathKind, operation.pathKind),
    eq(localFileOperationTable.intent, operation.intent),
    eq(localFileOperationTable.createdAt, operation.createdAt),
  );
}

/** Bind a reviewed decision to immutable intent and its exact recorded error. */
export function reviewedOperationIdentity(operation: Operation) {
  return and(
    operationIdentity(operation),
    operation.error === null
      ? isNull(localFileOperationTable.error)
      : eq(localFileOperationTable.error, operation.error),
  );
}

/** Check evidence before reading disk. An identical concurrent confirmation stays idempotent. */
export async function requireReviewedRecovery(tx: Tx, operation: Operation) {
  const reviewed = await tx
    .select({ id: localFileOperationTable.id })
    .from(localFileOperationTable)
    .where(
      or(
        and(
          reviewedOperationIdentity(operation),
          eq(localFileOperationTable.state, operation.state),
        ),
        operation.state === "pending"
          ? and(
              operationIdentity(operation),
              eq(localFileOperationTable.state, "confirmed"),
              isNull(localFileOperationTable.error),
            )
          : undefined,
      ),
    )
    .get();
  if (!reviewed)
    throw new Error("Local filesystem operation evidence changed. Inspect again before confirming");
}
