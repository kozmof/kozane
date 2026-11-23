/** Trusted run-archive expectations preserve all five original source bindings. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoveryRunArchivesTable as table } from "../schema.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpoint,
} from "./local-recovery-checkpoint.js";
import { readLocalRecoveryCheckpoint } from "./local-recovery-store.js";
import { readSharedRecoveryCheckpoint } from "./shared-recovery-store.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import { readSharedRecoveryExecutionCheckpoint } from "./shared-recovery-execution-store.js";
import { parseSharedRecoveryExecutionHistory } from "./shared-recovery-executions.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseSharedRecoveryRunArchiveCheckpoint,
  parseSharedRecoveryRunArchive,
  requireSharedRecoveryRunArchiveCheckpoint,
  type SharedRecoveryRunArchiveCheckpoint,
  type SharedRecoveryRunArchiveSources,
} from "./shared-recovery-run-archive.js";
import { parseSharedRecoveryActionArchive } from "./shared-recovery-action-archive.js";
import {
  parseSharedRecoveryActionArchiveCheckpointRecord,
  readSharedRecoveryActionArchiveCheckpoint,
} from "./shared-recovery-action-archive-store.js";
import { parseSharedRecoveryActionHistory } from "./shared-recovery-actions.js";
import { readSharedRecoveryActionCheckpoint } from "./shared-recovery-action-store.js";

export interface SharedRecoveryRunArchiveCheckpointBinding {
  readonly checkpoint: SharedRecoveryRunArchiveCheckpoint;
  readonly localCheckpoint: LocalRecoveryCheckpoint;
}
function keyOf(checkpoint: Pick<SharedRecoveryRunArchiveCheckpoint, "checkpoint">) {
  const { workspaceId, deviceId, epochId, checkpointId } =
    checkpoint.checkpoint.checkpoint.checkpoint.checkpoint.identity;
  return { workspaceId, deviceId, epochId, checkpointId };
}
function where(key: LocalRecoveryCheckpointKey) {
  return and(
    eq(table.workspaceId, key.workspaceId),
    eq(table.deviceId, key.deviceId),
    eq(table.epochId, key.epochId),
    eq(table.checkpointId, key.checkpointId),
  );
}
/** Inspect coherent metadata even after source catalogs disappear. Timestamps never pass through Date. */
export function parseSharedRecoveryRunArchiveCheckpointRecord(
  key: unknown,
  descriptor: unknown,
  localDescriptor: unknown,
): SharedRecoveryRunArchiveCheckpointBinding {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored archive checkpoint requires TEXT");
  const checkpoint = parseSharedRecoveryRunArchiveCheckpoint(JSON.parse(descriptor));
  const source = parseSharedRecoveryActionArchiveCheckpointRecord(
    wanted,
    JSON.stringify(checkpoint.checkpoint),
    localDescriptor,
  );
  return Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
}
export async function readSharedRecoveryRunArchiveCheckpoint(
  db: DB | Tx | ReadTx,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  const row = await db
    .select({ descriptor: table.descriptor, localDescriptor: table.localDescriptor })
    .from(table)
    .where(where(key))
    .get();
  return row
    ? parseSharedRecoveryRunArchiveCheckpointRecord(key, row.descriptor, row.localDescriptor)
    : null;
}
export function inspectSharedRecoveryRunArchiveCheckpoint(
  db: DB,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readSharedRecoveryRunArchiveCheckpoint(tx, key));
}
async function requireSources(
  db: DB | Tx | ReadTx,
  binding: SharedRecoveryRunArchiveCheckpointBinding,
) {
  const key = keyOf(binding.checkpoint),
    action = binding.checkpoint.checkpoint.checkpoint,
    execution = action.checkpoint;
  const archive = await readSharedRecoveryActionArchiveCheckpoint(db, key);
  if (
    !archive ||
    JSON.stringify(archive.checkpoint) !== JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(archive.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError(
      "Trusted original-action archive source binding is missing or changed",
    );
  const originals = await readSharedRecoveryActionCheckpoint(db, key);
  if (
    !originals ||
    JSON.stringify(originals.checkpoint) !== JSON.stringify(action) ||
    JSON.stringify(originals.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError("Trusted original archive source binding is missing or changed");
  const executions = await readSharedRecoveryExecutionCheckpoint(db, key);
  const shared = await readSharedRecoveryCheckpoint(db, key);
  const local = await readLocalRecoveryCheckpoint(db, key);
  if (
    !executions ||
    JSON.stringify(executions.checkpoint) !== JSON.stringify(execution) ||
    JSON.stringify(executions.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError("Trusted execution archive source binding is missing or changed");
  if (
    !shared ||
    JSON.stringify(shared.checkpoint) !== JSON.stringify(execution.checkpoint) ||
    JSON.stringify(shared.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError("Trusted shared archive source binding is missing or changed");
  if (!local || JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint))
    throw new SharedRecoveryError("Trusted local archive source binding is missing or changed");
}
/** Register trusted run inventory and contents without storing payload bytes. */
export async function rememberSharedRecoveryRunArchiveCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseSharedRecoveryRunArchiveCheckpoint(input),
    key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_run_archives SET descriptor=descriptor WHERE 0`);
  const source = await readSharedRecoveryActionArchiveCheckpoint(tx, key);
  if (!source)
    throw new SharedRecoveryError("Trusted original-action archive checkpoint is not registered");
  const binding = Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
  await requireSources(tx, binding);
  const existing = await readSharedRecoveryRunArchiveCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(binding))
      throw new SharedRecoveryError(
        "Retained checkpoint identity already has different contents or bindings",
      );
    return { binding: existing, changed: false };
  }
  await tx.insert(table).values({
    ...key,
    descriptor: JSON.stringify(checkpoint),
    localDescriptor: JSON.stringify(binding.localCheckpoint),
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
  });
  return { binding, changed: true };
}
export function rememberSharedRecoveryRunArchiveCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseSharedRecoveryRunArchiveCheckpoint(input);
  return withTx(db, (tx) => rememberSharedRecoveryRunArchiveCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const binding = await readSharedRecoveryRunArchiveCheckpoint(tx, key);
    if (!binding) throw new SharedRecoveryError("Trusted archive checkpoint is not registered");
    await requireSources(tx, binding);
    return binding;
  });
}
/** Own all inputs before catalog reads, hash outside their boundary, then recheck all six original expectations. */
export async function requireStoredSharedRecoveryRunArchiveCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  contents: SharedRecoveryRunArchiveSources,
) {
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryRunArchive(input);
  const archiveData = parseSharedRecoveryActionArchive(contents.actionArchive);
  const originalData = parseSharedRecoveryActionHistory(contents.originals);
  const sourceExecutions = parseSharedRecoveryExecutionHistory(contents.executions);
  const sourceHistory = parseSharedRecoveryHistoryPayload(contents.sharedHistory);
  if (
    JSON.stringify(payload.checkpoint.checkpoint.checkpoint.checkpoint.identity) !==
    JSON.stringify(identity)
  )
    throw new SharedRecoveryError("Recovery archive checkpoint identity mismatch");
  const key = keyOf(payload),
    binding = await trusted(catalog, key);
  const result = await requireSharedRecoveryRunArchiveCheckpoint(
    payload,
    binding.checkpoint,
    identity,
    {
      actionArchive: archiveData,
      originals: originalData,
      executions: sourceExecutions,
      sharedHistory: sourceHistory,
    },
  );
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(binding))
    throw new SharedRecoveryError("Trusted archive checkpoint changed during verification");
  return result;
}
