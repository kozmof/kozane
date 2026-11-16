import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withTx, type DB } from "../../../db/database.js";
import { localFileOperationTable } from "../../../db/schema.js";
import {
  prepareTaskspaceFileChange,
  type TaskspaceFileChange,
} from "../taskspace-file-operations.js";
import { TaskspaceFilesError } from "../taskspace-files.js";

export class TaskspaceFileOperationError extends Error {
  constructor(
    cause: unknown,
    readonly operationId: string,
    readonly phase: "change" | "confirm",
  ) {
    super("Taskspace file operation failed", { cause });
  }
}

/** Called inside the taskspace queue. Filesystem work runs once, between durable boundaries. */
export async function journalTaskspaceFileChange<T>(
  input: {
    db: DB;
    namespaceId: string;
    taskspaceId: string;
    root: string;
    baseDir: string;
    request: TaskspaceFileChange;
    currentBaseDir: () => Promise<string>;
  },
  change: (baseDir: string) => T | Promise<T>,
): Promise<T> {
  const { db, namespaceId, taskspaceId, root, baseDir, request } = input;
  const prepared = prepareTaskspaceFileChange(root, baseDir, request);
  const id = randomUUID();
  const identity = and(
    eq(localFileOperationTable.id, id),
    eq(localFileOperationTable.kind, "taskspace.file"),
    eq(localFileOperationTable.taskspaceId, taskspaceId),
    eq(localFileOperationTable.namespaceId, namespaceId),
    eq(localFileOperationTable.path, prepared.storedPath),
    eq(localFileOperationTable.pathKind, prepared.pathKind),
    eq(localFileOperationTable.intent, prepared.intent),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.state, "pending"),
  );
  await withTx(db, async (tx) => {
    await tx.insert(localFileOperationTable).values({
      id,
      kind: "taskspace.file",
      version: 1,
      taskspaceId,
      namespaceId,
      path: prepared.storedPath,
      pathKind: prepared.pathKind,
      intent: prepared.intent,
      state: "pending",
      createdAt: new Date(),
    });
  });
  let result: T;
  try {
    const currentBase = await input.currentBaseDir();
    const current = prepareTaskspaceFileChange(root, currentBase, request);
    if (
      current.base !== prepared.base ||
      current.real !== prepared.real ||
      current.intent !== prepared.intent
    )
      throw new TaskspaceFilesError(
        "stale",
        "Taskspace directory changed before the file operation",
      );
    result = await change(currentBase);
  } catch (error) {
    try {
      await withTx(db, async (tx) => {
        const recorded = await tx
          .update(localFileOperationTable)
          .set({ error: String(error) })
          .where(identity)
          .returning({ id: localFileOperationTable.id });
        if (recorded.length !== 1)
          throw new Error("Taskspace file intent changed or is missing", { cause: error });
      });
    } catch (recordError) {
      throw new TaskspaceFileOperationError(
        new AggregateError([error, recordError], "File operation and error recording failed"),
        id,
        "change",
      );
    }
    throw new TaskspaceFileOperationError(error, id, "change");
  }
  try {
    await withTx(db, async (tx) => {
      const confirmed = await tx
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt: new Date(), error: null })
        .where(identity)
        .returning({ id: localFileOperationTable.id });
      if (confirmed.length !== 1) throw new Error("Taskspace file intent changed or is missing");
    });
  } catch (error) {
    throw new TaskspaceFileOperationError(error, id, "confirm");
  }
  return result;
}
