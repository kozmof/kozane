import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTx, type DB } from "../../../db/database.js";
import { localFileOperationTable, taskspaceTable } from "../../../db/schema.js";
import { addTaskspaceInTx, updateTaskspaceLocationInTx } from "../../../db/api/taskspace.js";
import { taskspaceMarkerText } from "../../taskspace-marker.js";
import { claimTaskspaceDirectory } from "../taskspace-directory.js";
import { storedLocation } from "../taskspace-path.js";
import { contentHash } from "../local-file-operations.js";

type DirectoryInput = Omit<
  Parameters<typeof claimTaskspaceDirectory>[0],
  "taskspaceId" | "namespaceId"
>;
type RecordInput = Omit<Parameters<typeof updateTaskspaceLocationInTx>[0], "db" | "taskspaceId"> & {
  db: DB;
  namespaceId: string;
  scopeId?: string;
  name: string;
};

export class TaskspaceClaimError extends Error {
  constructor(
    cause: unknown,
    readonly operationId: string,
    readonly phase: "claim" | "attach",
  ) {
    super("Taskspace directory claim failed", { cause });
  }
}

/** Commit intent before touching disk; publish the attachment only with confirmation. */
export async function claimRecordedTaskspace(record: RecordInput, directory: DirectoryInput) {
  const location = storedLocation(directory.workspaceRoot, directory.targetDir);
  if (record.path !== location.storedPath || record.pathKind !== location.pathKind)
    throw new Error("Taskspace attachment does not match the claimed directory");
  const operationId = randomUUID();
  const id = await withTx(record.db, async (db) => {
    const taskspaceId = await addTaskspaceInTx({
      db,
      namespaceId: record.namespaceId,
      name: record.name,
      scopeId: record.scopeId,
    });
    // Adoption determines ownership only after mkdir. Retain each legitimate byte hash.
    const ownership = directory.ownIfCreated
      ? directory.adoptExisting
        ? [false, true]
        : [true]
      : [false];
    await db.insert(localFileOperationTable).values({
      id: operationId,
      kind: "taskspace.claim",
      version: 1,
      taskspaceId,
      namespaceId: record.namespaceId,
      path: location.storedPath,
      pathKind: location.pathKind,
      state: "pending",
      intent: JSON.stringify({
        adoptExisting: directory.adoptExisting,
        parentsInside: directory.parentsInside,
        ownIfCreated: directory.ownIfCreated,
        markerHashes: ownership.map((owned) =>
          contentHash(taskspaceMarkerText(taskspaceId, record.namespaceId, owned)),
        ),
      }),
      createdAt: new Date(),
    });
    return taskspaceId;
  });
  try {
    claimTaskspaceDirectory({ ...directory, taskspaceId: id, namespaceId: record.namespaceId });
  } catch (error) {
    try {
      await withTx(record.db, async (db) => {
        // Namespace deletion may already have removed this identity during the disk phase.
        await db.delete(taskspaceTable).where(eq(taskspaceTable.id, id));
        await db
          .update(localFileOperationTable)
          .set({ error: String(error) })
          .where(eq(localFileOperationTable.id, operationId));
      });
    } catch (cleanupError) {
      throw new TaskspaceClaimError(
        new AggregateError([error, cleanupError], "Directory claim and compensation failed"),
        operationId,
        "claim",
      );
    }
    throw new TaskspaceClaimError(error, operationId, "claim");
  }
  try {
    await withTx(record.db, async (db) => {
      await updateTaskspaceLocationInTx({
        db,
        taskspaceId: id,
        path: location.storedPath,
        pathKind: location.pathKind,
        ...(record.lastSeenAt !== undefined && { lastSeenAt: record.lastSeenAt }),
      });
      const confirmed = await db
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt: new Date(), error: null })
        .where(eq(localFileOperationTable.id, operationId))
        .returning({ id: localFileOperationTable.id });
      if (confirmed.length !== 1) throw new Error("Directory claim intent is missing");
    });
  } catch (error) {
    // Other processes may already see the marker. Preserve it and the pending intent.
    throw new TaskspaceClaimError(error, operationId, "attach");
  }
  return id;
}
