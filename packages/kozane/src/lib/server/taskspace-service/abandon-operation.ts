/** Retain an operator's decision without running, reversing or confirming filesystem work. */
import { and, eq } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { oneAtATime } from "./queue.js";

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
      if (current.state === "abandoned") return { operation: current, changed: false };
      const [operation] = await tx
        .update(localFileOperationTable)
        .set({ state: "abandoned", abandonedAt: new Date(), abandonReason: reason })
        .where(
          and(
            eq(localFileOperationTable.id, operationId),
            eq(localFileOperationTable.state, "pending"),
          ),
        )
        .returning();
      if (!operation) throw new Error("Operation is no longer pending");
      return { operation, changed: true };
    }),
  );
}
