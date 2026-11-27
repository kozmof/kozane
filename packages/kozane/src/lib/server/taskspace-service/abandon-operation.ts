/** Retain an operator's decision without running, reversing or confirming filesystem work. */
import { and, eq, isNull } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { oneAtATime } from "./queue.js";

/** The decision covers this exact inspected evidence, including any recorded error. */
function reviewedIdentity(operation: typeof localFileOperationTable.$inferSelect) {
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
    operation.error === null
      ? isNull(localFileOperationTable.error)
      : eq(localFileOperationTable.error, operation.error),
  );
}

async function inspect(db: ReadTx | Tx, operationId: string, reason: string) {
  const operation = await db
    .select()
    .from(localFileOperationTable)
    .where(eq(localFileOperationTable.id, operationId))
    .get();
  if (!operation) throw new Error("Local filesystem operation not found");
  if (operation.state === "confirmed") throw new Error("Completed operations cannot be abandoned");
  if (operation.state === "abandoned" && operation.abandonReason !== reason)
    throw new Error("Operation was already abandoned with another reason");
  return operation;
}

export async function abandonLocalOperation(
  db: DB,
  operationId: string,
  inputReason: string,
  apply = false,
) {
  const reason = inputReason.trim();
  if (!reason || reason.length > 1000 || reason.includes("\0"))
    throw new Error("Abandonment reason must contain 1–1000 characters without NUL");
  const preview = await withReadTx(db, (tx) => inspect(tx, operationId, reason));
  if (!apply || preview.state === "abandoned") return { operation: preview, changed: false };
  return oneAtATime(preview.taskspaceId, () =>
    withTx(db, async (tx) => {
      const current = await inspect(tx, operationId, reason);
      if (current.taskspaceId !== preview.taskspaceId)
        throw new Error("Operation identity changed");
      const reviewed = await tx
        .select({ id: localFileOperationTable.id })
        .from(localFileOperationTable)
        .where(reviewedIdentity(preview))
        .get();
      if (!reviewed) throw new Error("Operation evidence changed. Inspect again before abandoning");
      if (current.state === "abandoned") return { operation: current, changed: false };
      const now = new Date();
      const abandoned = await tx
        .update(localFileOperationTable)
        .set({ state: "abandoned", abandonedAt: now, abandonReason: reason })
        .where(and(reviewedIdentity(preview), eq(localFileOperationTable.state, "pending")))
        .returning({ id: localFileOperationTable.id });
      if (abandoned.length !== 1) throw new Error("Operation is no longer pending");
      // RETURNING precedes AFTER triggers. Read the final decision and original evidence.
      const operation = await tx
        .select()
        .from(localFileOperationTable)
        .where(
          and(
            reviewedIdentity(preview),
            eq(localFileOperationTable.state, "abandoned"),
            eq(localFileOperationTable.abandonedAt, now),
            eq(localFileOperationTable.abandonReason, reason),
          ),
        )
        .get();
      if (!operation) throw new Error("Operation abandonment changed or is missing");
      return { operation, changed: true };
    }),
  );
}
