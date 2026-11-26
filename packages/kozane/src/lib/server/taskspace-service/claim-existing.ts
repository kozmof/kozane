/** Attach this device's directory without creating or compensating a shared taskspace. */
import { and, eq } from "drizzle-orm";
import { withReadTx, type DB, type Tx, type ReadTx } from "../../../db/database.js";
import {
  localFileOperationTable,
  namespaceTable,
  taskspaceLocalTable,
  taskspaceTable,
} from "../../../db/schema.js";
import { updateTaskspaceLocationInTx } from "../../../db/api/taskspace.js";
import { claimTaskspaceDirectory } from "../taskspace-directory.js";
import { storedLocation } from "../taskspace-path.js";
import { inspectLocalClaim, localClaimIntent } from "../local-file-operations.js";
import type { PathKind } from "../../constants.js";
import { journalLocalOperation } from "./journal-operation.js";
import { oneAtATime } from "./queue.js";

type DirectoryInput = Omit<
  Parameters<typeof claimTaskspaceDirectory>[0],
  "taskspaceId" | "namespaceId"
>;
export interface ExistingTaskspaceClaim {
  readonly db: DB;
  readonly namespaceId: string;
  readonly taskspaceId: string;
  readonly path: string;
  readonly pathKind: PathKind;
  readonly lastSeenAt?: Date;
}

export async function claimExistingTaskspace(
  input: ExistingTaskspaceClaim,
  requestedDirectory: DirectoryInput,
) {
  const record = {
    ...input,
    lastSeenAt: input.lastSeenAt === undefined ? undefined : new Date(input.lastSeenAt.getTime()),
  };
  const directory = Object.freeze({ ...requestedDirectory });
  if (record.lastSeenAt !== undefined && !Number.isSafeInteger(record.lastSeenAt.getTime()))
    throw Error("Invalid directory observation timestamp");
  const location = storedLocation(directory.workspaceRoot, directory.targetDir);
  if (record.path !== location.storedPath || record.pathKind !== location.pathKind)
    throw Error("Taskspace attachment does not match the claimed directory");
  const intent = Object.freeze({
    kind: "taskspace.claim" as const,
    taskspaceId: record.taskspaceId,
    namespaceId: record.namespaceId,
    path: location.storedPath,
    pathKind: location.pathKind,
    intent: localClaimIntent(record.taskspaceId, record.namespaceId, {
      adoptExisting: directory.adoptExisting,
      parentsInside: directory.parentsInside,
      ownIfCreated: directory.ownIfCreated,
    }),
  });
  const evidence = Object.freeze({ ...intent, version: 1 });
  async function requireTarget(tx: Tx | ReadTx) {
    const namespace = await tx
      .select({ id: namespaceTable.id })
      .from(namespaceTable)
      .where(eq(namespaceTable.id, record.namespaceId))
      .get();
    if (!namespace) throw Error("Namespace not found");
    const shared = await tx
      .select({ namespaceId: taskspaceTable.namespaceId })
      .from(taskspaceTable)
      .where(eq(taskspaceTable.id, record.taskspaceId))
      .get();
    if (!shared) throw Error("Taskspace not found");
    if (shared.namespaceId !== record.namespaceId)
      throw Error("Taskspace namespace does not match directory claim");
    const attachment = await tx
      .select({ path: taskspaceLocalTable.path })
      .from(taskspaceLocalTable)
      .where(eq(taskspaceLocalTable.taskspaceId, record.taskspaceId))
      .get();
    if (attachment?.path !== null && attachment?.path !== undefined)
      throw Error("Taskspace already has a directory attachment");
  }
  async function requirePending(tx: Tx | ReadTx, operationId: string) {
    const pending = await tx
      .select({ id: localFileOperationTable.id })
      .from(localFileOperationTable)
      .where(
        and(
          eq(localFileOperationTable.id, operationId),
          eq(localFileOperationTable.taskspaceId, intent.taskspaceId),
          eq(localFileOperationTable.namespaceId, intent.namespaceId),
          eq(localFileOperationTable.kind, intent.kind),
          eq(localFileOperationTable.version, 1),
          eq(localFileOperationTable.path, intent.path),
          eq(localFileOperationTable.pathKind, intent.pathKind),
          eq(localFileOperationTable.intent, intent.intent),
          eq(localFileOperationTable.state, "pending"),
        ),
      )
      .get();
    if (!pending) throw Error("Directory claim intent changed or is missing");
  }
  return oneAtATime(record.taskspaceId, () =>
    journalLocalOperation(
      record.db,
      intent,
      async (operationId) => {
        await withReadTx(record.db, async (tx) => {
          await requirePending(tx, operationId);
          await requireTarget(tx);
        });
        claimTaskspaceDirectory({
          ...directory,
          taskspaceId: record.taskspaceId,
          namespaceId: record.namespaceId,
        });
      },
      async (tx, _result, operationId) => {
        await requirePending(tx, operationId);
        await requireTarget(tx);
        const observed = inspectLocalClaim(evidence, directory.workspaceRoot);
        if (observed !== "matching-marker")
          throw Error(`Directory claim cannot be confirmed: ${observed}`);
        await updateTaskspaceLocationInTx({
          db: tx,
          taskspaceId: record.taskspaceId,
          path: location.storedPath,
          pathKind: location.pathKind,
          lastSeenAt: record.lastSeenAt ?? new Date(),
        });
        return record.taskspaceId;
      },
      async (tx) => {
        await requireTarget(tx);
        const pending = await tx
          .select({ id: localFileOperationTable.id })
          .from(localFileOperationTable)
          .where(
            and(
              eq(localFileOperationTable.taskspaceId, record.taskspaceId),
              eq(localFileOperationTable.state, "pending"),
            ),
          )
          .get();
        if (pending) throw Error(`Taskspace has pending local work: ${pending.id}`);
        const observed = inspectLocalClaim(evidence, directory.workspaceRoot);
        if (
          observed !== "absent" &&
          !(observed === "directory-without-marker" && directory.adoptExisting)
        )
          throw Error(`Directory cannot be claimed: ${observed}`);
      },
    ),
  );
}
