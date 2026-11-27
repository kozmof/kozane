import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import {
  cardTable,
  localFileOperationTable,
  namespaceTable,
  taskspaceLocalTable,
  taskspaceTable,
} from "../../../db/schema.js";
import { addTaskspaceInTx, updateTaskspaceLocationInTx } from "../../../db/api/taskspace.js";
import { claimTaskspaceDirectory } from "../taskspace-directory.js";
import { storedLocation } from "../taskspace-path.js";
import { inspectLocalClaim, localClaimIntent } from "../local-file-operations.js";

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

type ClaimPlan = {
  shared: typeof taskspaceTable.$inferSelect;
  intent: Pick<
    typeof localFileOperationTable.$inferSelect,
    | "id"
    | "kind"
    | "version"
    | "taskspaceId"
    | "namespaceId"
    | "path"
    | "pathKind"
    | "intent"
    | "createdAt"
  >;
};
function journalIdentity({ intent }: ClaimPlan) {
  return and(
    eq(localFileOperationTable.id, intent.id),
    eq(localFileOperationTable.kind, "taskspace.claim"),
    eq(localFileOperationTable.version, 1),
    eq(localFileOperationTable.taskspaceId, intent.taskspaceId),
    eq(localFileOperationTable.namespaceId, intent.namespaceId),
    eq(localFileOperationTable.path, intent.path),
    eq(localFileOperationTable.pathKind, intent.pathKind),
    eq(localFileOperationTable.intent, intent.intent),
    eq(localFileOperationTable.createdAt, intent.createdAt),
  );
}
function pendingIdentity(plan: ClaimPlan) {
  return and(
    journalIdentity(plan),
    eq(localFileOperationTable.state, "pending"),
    isNull(localFileOperationTable.error),
  );
}
function sharedIdentity({ shared }: ClaimPlan) {
  return and(
    eq(taskspaceTable.id, shared.id),
    shared.namespaceId === null
      ? isNull(taskspaceTable.namespaceId)
      : eq(taskspaceTable.namespaceId, shared.namespaceId),
    shared.scopeId === null
      ? isNull(taskspaceTable.scopeId)
      : eq(taskspaceTable.scopeId, shared.scopeId),
    eq(taskspaceTable.name, shared.name),
    eq(taskspaceTable.createdAt, shared.createdAt),
    eq(taskspaceTable.updatedAt, shared.updatedAt),
  );
}
async function requirePending(db: ReadTx | Tx, plan: ClaimPlan) {
  const row = await db
    .select({ id: localFileOperationTable.id })
    .from(localFileOperationTable)
    .where(pendingIdentity(plan))
    .get();
  if (!row) throw new Error("Directory claim intent changed or is missing");
}
async function requireOriginalShared(db: ReadTx | Tx, plan: ClaimPlan) {
  const row = await db
    .select({ id: taskspaceTable.id })
    .from(taskspaceTable)
    .where(sharedIdentity(plan))
    .get();
  if (!row) throw new Error("Created taskspace changed or is missing");
  const namespace = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, plan.intent.namespaceId))
    .get();
  if (!namespace) throw new Error("Taskspace namespace no longer exists");
}
async function requireNoLocal(db: ReadTx | Tx, plan: ClaimPlan) {
  const row = await db
    .select({ id: taskspaceLocalTable.taskspaceId })
    .from(taskspaceLocalTable)
    .where(eq(taskspaceLocalTable.taskspaceId, plan.shared.id))
    .get();
  if (row) throw new Error("Created taskspace already has local metadata");
}
async function compensate(db: Tx, plan: ClaimPlan, error: unknown) {
  await requirePending(db, plan);
  await requireNoLocal(db, plan);
  const linked = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .where(eq(cardTable.taskspaceId, plan.shared.id))
    .get();
  if (linked) throw new Error("Created taskspace has linked cards", { cause: error });
  const current = await db
    .select({ id: taskspaceTable.id })
    .from(taskspaceTable)
    .where(eq(taskspaceTable.id, plan.shared.id))
    .get();
  if (current) {
    const removed = await db
      .delete(taskspaceTable)
      .where(sharedIdentity(plan))
      .returning({ id: taskspaceTable.id });
    if (removed.length !== 1)
      throw new Error("Created taskspace changed before compensation", { cause: error });
  }
  const message = String(error);
  const recorded = await db
    .update(localFileOperationTable)
    .set({ error: message })
    .where(pendingIdentity(plan))
    .returning({ id: localFileOperationTable.id });
  if (recorded.length !== 1)
    throw new Error("Directory claim intent changed before compensation", { cause: error });
  const receipt = await db
    .select({ id: localFileOperationTable.id })
    .from(localFileOperationTable)
    .where(
      and(
        journalIdentity(plan),
        eq(localFileOperationTable.state, "pending"),
        eq(localFileOperationTable.error, message),
      ),
    )
    .get();
  if (!receipt)
    throw new Error("Directory claim error record changed or is missing", { cause: error });
  const remaining = await db
    .select({ id: taskspaceTable.id })
    .from(taskspaceTable)
    .where(eq(taskspaceTable.id, plan.shared.id))
    .get();
  if (remaining)
    throw new Error("Directory claim compensation did not remove its shared identity", {
      cause: error,
    });
  await requireNoLocal(db, plan);
}

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
export async function claimRecordedTaskspace(
  input: RecordInput,
  requestedDirectory: DirectoryInput,
) {
  const record = {
    ...input,
    lastSeenAt: input.lastSeenAt == null ? input.lastSeenAt : new Date(input.lastSeenAt.getTime()),
  };
  const directory = Object.freeze({ ...requestedDirectory });
  if (record.lastSeenAt != null && !Number.isSafeInteger(record.lastSeenAt.getTime()))
    throw new Error("Invalid directory observation timestamp");
  const location = storedLocation(directory.workspaceRoot, directory.targetDir);
  if (record.path !== location.storedPath || record.pathKind !== location.pathKind)
    throw new Error("Taskspace attachment does not match the claimed directory");
  const operationId = randomUUID();
  const plan = await withTx(record.db, async (db) => {
    const taskspaceId = await addTaskspaceInTx({
      db,
      namespaceId: record.namespaceId,
      name: record.name,
      scopeId: record.scopeId,
    });
    const shared = await db
      .select()
      .from(taskspaceTable)
      .where(eq(taskspaceTable.id, taskspaceId))
      .get();
    if (
      !shared ||
      shared.namespaceId !== record.namespaceId ||
      shared.name !== record.name ||
      shared.scopeId !== (record.scopeId ?? null)
    )
      throw new Error("Created taskspace does not match the requested identity");
    const intent: ClaimPlan["intent"] = {
      id: operationId,
      kind: "taskspace.claim",
      version: 1,
      taskspaceId,
      namespaceId: record.namespaceId,
      path: location.storedPath,
      pathKind: location.pathKind,
      intent: localClaimIntent(taskspaceId, record.namespaceId, {
        adoptExisting: directory.adoptExisting,
        parentsInside: directory.parentsInside,
        ownIfCreated: directory.ownIfCreated,
      }),
      createdAt: new Date(),
    };
    const plan = { shared, intent };
    await db.insert(localFileOperationTable).values({ ...intent, state: "pending" });
    await requirePending(db, plan);
    await requireOriginalShared(db, plan);
    await requireNoLocal(db, plan);
    return plan;
  });
  const id = plan.shared.id;
  try {
    await withReadTx(record.db, async (db) => {
      await requirePending(db, plan);
      await requireOriginalShared(db, plan);
      await requireNoLocal(db, plan);
    });
  } catch (error) {
    throw new TaskspaceClaimError(error, operationId, "attach");
  }
  try {
    claimTaskspaceDirectory({ ...directory, taskspaceId: id, namespaceId: record.namespaceId });
  } catch (error) {
    try {
      // Namespace deletion may already have removed the original identity during disk work.
      await withTx(record.db, (db) => compensate(db, plan, error));
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
      await requirePending(db, plan);
      await requireOriginalShared(db, plan);
      await requireNoLocal(db, plan);
      const observed = inspectLocalClaim(plan.intent, directory.workspaceRoot);
      if (observed !== "matching-marker")
        throw new Error(`Directory claim cannot be confirmed: ${observed}`);
      await updateTaskspaceLocationInTx({
        db,
        taskspaceId: id,
        path: location.storedPath,
        pathKind: location.pathKind,
        ...(record.lastSeenAt !== undefined && { lastSeenAt: record.lastSeenAt }),
      });
      const confirmedAt = new Date();
      const confirmed = await db
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt, error: null })
        .where(pendingIdentity(plan))
        .returning({ id: localFileOperationTable.id });
      if (confirmed.length !== 1) throw new Error("Directory claim intent changed or is missing");
      const receipt = await db
        .select({ id: localFileOperationTable.id })
        .from(localFileOperationTable)
        .where(
          and(
            journalIdentity(plan),
            eq(localFileOperationTable.state, "confirmed"),
            eq(localFileOperationTable.confirmedAt, confirmedAt),
            isNull(localFileOperationTable.error),
          ),
        )
        .get();
      if (!receipt) throw new Error("Directory claim confirmation changed or is missing");
      await requireOriginalShared(db, plan);
      const attachment = await db
        .select({ id: taskspaceLocalTable.taskspaceId })
        .from(taskspaceLocalTable)
        .where(
          and(
            eq(taskspaceLocalTable.taskspaceId, id),
            eq(taskspaceLocalTable.path, location.storedPath),
            eq(taskspaceLocalTable.pathKind, location.pathKind),
            record.lastSeenAt == null
              ? isNull(taskspaceLocalTable.lastSeenAt)
              : eq(taskspaceLocalTable.lastSeenAt, record.lastSeenAt),
          ),
        )
        .get();
      if (!attachment) throw new Error("Directory claim attachment changed or is missing");
      const finalObservation = inspectLocalClaim(plan.intent, directory.workspaceRoot);
      if (finalObservation !== "matching-marker")
        throw new Error(`Directory claim cannot be confirmed: ${finalObservation}`);
    });
  } catch (error) {
    // Other processes may already see the marker. Preserve it and the pending intent.
    throw new TaskspaceClaimError(error, operationId, "attach");
  }
  return id;
}
