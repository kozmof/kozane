import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
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
  const owned = Object.freeze({
    kind: intent.kind,
    taskspaceId: intent.taskspaceId,
    namespaceId: intent.namespaceId,
    path: intent.path,
    pathKind: intent.pathKind,
    intent: intent.intent,
  });
  const id = randomUUID();
  const createdAt = new Date();
  const identity = and(
    eq(localFileOperationTable.id, id),
    eq(localFileOperationTable.kind, owned.kind),
    eq(localFileOperationTable.taskspaceId, owned.taskspaceId),
    eq(localFileOperationTable.namespaceId, owned.namespaceId),
    eq(localFileOperationTable.path, owned.path),
    eq(localFileOperationTable.pathKind, owned.pathKind),
    eq(localFileOperationTable.intent, owned.intent),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.createdAt, createdAt),
  );
  const pending = and(
    identity,
    eq(localFileOperationTable.state, "pending"),
    isNull(localFileOperationTable.error),
  );
  async function requirePending(tx: ReadTx | Tx) {
    const row = await tx
      .select({ id: localFileOperationTable.id })
      .from(localFileOperationTable)
      .where(pending)
      .get();
    if (!row) throw new Error("Local filesystem intent changed or is missing");
  }
  await withTx(db, async (tx) => {
    await beforeRecord?.(tx);
    await tx
      .insert(localFileOperationTable)
      .values({ ...owned, id, version: 1, state: "pending", createdAt });
    await requirePending(tx);
  });
  let result: T;
  try {
    await withReadTx(db, requirePending);
    result = await change(id);
  } catch (error) {
    try {
      await withTx(db, async (tx) => {
        const message = String(error);
        const recorded = await tx
          .update(localFileOperationTable)
          .set({ error: message })
          .where(pending)
          .returning({ id: localFileOperationTable.id });
        if (recorded.length !== 1)
          throw new Error("Local filesystem intent changed or is missing", { cause: error });
        const receipt = await tx
          .select({ id: localFileOperationTable.id })
          .from(localFileOperationTable)
          .where(
            and(
              identity,
              eq(localFileOperationTable.state, "pending"),
              eq(localFileOperationTable.error, message),
            ),
          )
          .get();
        if (!receipt)
          throw new Error("Local filesystem error record changed or is missing", { cause: error });
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
      await requirePending(tx);
      const response = await commit(tx, result, id);
      const confirmedAt = new Date();
      const confirmed = await tx
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt, error: null })
        .where(pending)
        .returning({ id: localFileOperationTable.id });
      if (confirmed.length !== 1) throw new Error("Local filesystem intent changed or is missing");
      // RETURNING precedes AFTER triggers. Read back the durable confirmation before success.
      const receipt = await tx
        .select({ id: localFileOperationTable.id })
        .from(localFileOperationTable)
        .where(
          and(
            identity,
            eq(localFileOperationTable.state, "confirmed"),
            eq(localFileOperationTable.confirmedAt, confirmedAt),
            isNull(localFileOperationTable.error),
          ),
        )
        .get();
      if (!receipt) throw new Error("Local filesystem confirmation changed or is missing");
      return response;
    });
  } catch (error) {
    throw new LocalOperationError(error, id, "confirm");
  }
}
