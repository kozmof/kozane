import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withTx, type DB, type Tx } from "../../../db/database.js";
import { localFileOperationTable } from "../../../db/schema.js";

type Intent = Pick<
  typeof localFileOperationTable.$inferInsert,
  "taskspaceId" | "namespaceId" | "path" | "pathKind" | "intent"
> & {
  kind: "taskspace.file" | "taskspace.directory" | "taskspace.claim";
};
export class LocalOperationError extends Error {
  constructor(
    cause: unknown,
    readonly operationId: string,
    readonly phase: "change" | "confirm",
  ) {
    super("Local filesystem operation failed", { cause });
  }
}

/** The caller owns its taskspace queue. Disk work runs once between database transactions. */
export async function journalLocalOperation<T, R>(
  db: DB,
  intent: Intent,
  change: (operationId: string) => T | Promise<T>,
  commit: (tx: Tx, result: T, operationId: string) => R | Promise<R>,
  beforeRecord?: (tx: Tx) => Promise<void>,
): Promise<R> {
  const id = randomUUID();
  const identity = and(
    eq(localFileOperationTable.id, id),
    eq(localFileOperationTable.kind, intent.kind),
    eq(localFileOperationTable.taskspaceId, intent.taskspaceId),
    eq(localFileOperationTable.namespaceId, intent.namespaceId),
    eq(localFileOperationTable.path, intent.path),
    eq(localFileOperationTable.pathKind, intent.pathKind),
    eq(localFileOperationTable.intent, intent.intent),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.state, "pending"),
  );
  await withTx(db, async (tx) => {
    await beforeRecord?.(tx);
    await tx
      .insert(localFileOperationTable)
      .values({ ...intent, id, version: 1, state: "pending", createdAt: new Date() });
  });
  let result: T;
  try {
    result = await change(id);
  } catch (error) {
    try {
      await withTx(db, async (tx) => {
        const recorded = await tx
          .update(localFileOperationTable)
          .set({ error: String(error) })
          .where(identity)
          .returning({ id: localFileOperationTable.id });
        if (recorded.length !== 1)
          throw new Error("Local filesystem intent changed or is missing", { cause: error });
      });
    } catch (recordError) {
      throw new LocalOperationError(
        new AggregateError([error, recordError], "Filesystem operation and error recording failed"),
        id,
        "change",
      );
    }
    throw new LocalOperationError(error, id, "change");
  }
  try {
    return await withTx(db, async (tx) => {
      const response = await commit(tx, result, id);
      const confirmed = await tx
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt: new Date(), error: null })
        .where(identity)
        .returning({ id: localFileOperationTable.id });
      if (confirmed.length !== 1) throw new Error("Local filesystem intent changed or is missing");
      return response;
    });
  } catch (error) {
    throw new LocalOperationError(error, id, "confirm");
  }
}
