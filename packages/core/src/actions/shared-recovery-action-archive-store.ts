/** Trusted action-archive expectations preserve all four original source bindings. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoveryActionArchivesTable as table } from "../schema.js";
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
  parseSharedRecoveryActionArchiveCheckpoint,
  parseSharedRecoveryActionArchive,
  requireSharedRecoveryActionArchiveCheckpoint,
  type SharedRecoveryActionArchiveCheckpoint,
  type SharedRecoveryActionArchiveSources,
} from "./shared-recovery-action-archive.js";
import { parseSharedRecoveryActionHistory } from "./shared-recovery-actions.js";
import {
  parseSharedRecoveryActionCheckpointRecord,
  readSharedRecoveryActionCheckpoint,
} from "./shared-recovery-action-store.js";

export interface SharedRecoveryActionArchiveCheckpointBinding {
  readonly checkpoint: SharedRecoveryActionArchiveCheckpoint;
  readonly localCheckpoint: LocalRecoveryCheckpoint;
}
function keyOf(checkpoint: Pick<SharedRecoveryActionArchiveCheckpoint, "checkpoint">) {
  const { workspaceId, deviceId, epochId, checkpointId } =
    checkpoint.checkpoint.checkpoint.checkpoint.identity;
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
export function parseSharedRecoveryActionArchiveCheckpointRecord(
  key: unknown,
  descriptor: unknown,
  localDescriptor: unknown,
): SharedRecoveryActionArchiveCheckpointBinding {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored archive checkpoint requires TEXT");
  const checkpoint = parseSharedRecoveryActionArchiveCheckpoint(JSON.parse(descriptor));
  const source = parseSharedRecoveryActionCheckpointRecord(
    wanted,
    JSON.stringify(checkpoint.checkpoint),
    localDescriptor,
  );
  return Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
}
export async function readSharedRecoveryActionArchiveCheckpoint(
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
    ? parseSharedRecoveryActionArchiveCheckpointRecord(key, row.descriptor, row.localDescriptor)
    : null;
}
export function inspectSharedRecoveryActionArchiveCheckpoint(
  db: DB,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readSharedRecoveryActionArchiveCheckpoint(tx, key));
}
async function requireSources(
  db: DB | Tx | ReadTx,
  binding: SharedRecoveryActionArchiveCheckpointBinding,
) {
  const key = keyOf(binding.checkpoint),
    action = binding.checkpoint.checkpoint,
    execution = action.checkpoint;
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
/** Register trusted archive root and action inventory and contents without storing payload bytes. */
export async function rememberSharedRecoveryActionArchiveCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseSharedRecoveryActionArchiveCheckpoint(input),
    key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_action_archives SET descriptor=descriptor WHERE 0`);
  const source = await readSharedRecoveryActionCheckpoint(tx, key);
  if (!source)
    throw new SharedRecoveryError("Trusted original action checkpoint is not registered");
  const binding = Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
  await requireSources(tx, binding);
  const existing = await readSharedRecoveryActionArchiveCheckpoint(tx, key);
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
export function rememberSharedRecoveryActionArchiveCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseSharedRecoveryActionArchiveCheckpoint(input);
  return withTx(db, (tx) => rememberSharedRecoveryActionArchiveCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const binding = await readSharedRecoveryActionArchiveCheckpoint(tx, key);
    if (!binding) throw new SharedRecoveryError("Trusted archive checkpoint is not registered");
    await requireSources(tx, binding);
    return binding;
  });
}
/** Own all inputs before catalog reads, hash outside their boundary, then recheck all five original expectations. */
export async function requireStoredSharedRecoveryActionArchiveCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  contents: SharedRecoveryActionArchiveSources,
) {
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryActionArchive(input);
  const originalData = parseSharedRecoveryActionHistory(contents.originals);
  const sourceExecutions = parseSharedRecoveryExecutionHistory(contents.executions);
  const sourceHistory = parseSharedRecoveryHistoryPayload(contents.sharedHistory);
  if (
    JSON.stringify(payload.checkpoint.checkpoint.checkpoint.identity) !== JSON.stringify(identity)
  )
    throw new SharedRecoveryError("Recovery archive checkpoint identity mismatch");
  const key = keyOf(payload),
    binding = await trusted(catalog, key);
  const result = await requireSharedRecoveryActionArchiveCheckpoint(
    payload,
    binding.checkpoint,
    identity,
    { originals: originalData, executions: sourceExecutions, sharedHistory: sourceHistory },
  );
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(binding))
    throw new SharedRecoveryError("Trusted archive checkpoint changed during verification");
  return result;
}
