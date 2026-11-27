/** Trusted original-action expectations retain the exact execution, shared and local bindings. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoveryActionsTable as table } from "../schema.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpoint,
} from "./local-recovery-checkpoint.js";
import { readLocalRecoveryCheckpoint } from "./local-recovery-store.js";
import { readSharedRecoveryCheckpoint } from "./shared-recovery-store.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import {
  readSharedRecoveryExecutionCheckpoint,
  parseSharedRecoveryExecutionCheckpointRecord,
} from "./shared-recovery-execution-store.js";
import { parseSharedRecoveryExecutionHistory } from "./shared-recovery-executions.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseSharedRecoveryActionCheckpoint,
  parseSharedRecoveryActionHistory,
  requireSharedRecoveryActionCheckpoint,
  type SharedRecoveryActionCheckpoint,
} from "./shared-recovery-actions.js";

export interface SharedRecoveryActionCheckpointBinding {
  readonly checkpoint: SharedRecoveryActionCheckpoint;
  readonly localCheckpoint: LocalRecoveryCheckpoint;
}
function keyOf(checkpoint: Pick<SharedRecoveryActionCheckpoint, "checkpoint">) {
  const { workspaceId, deviceId, epochId, checkpointId } =
    checkpoint.checkpoint.checkpoint.identity;
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
export function parseSharedRecoveryActionCheckpointRecord(
  key: unknown,
  descriptor: unknown,
  localDescriptor: unknown,
): SharedRecoveryActionCheckpointBinding {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored action checkpoint requires TEXT");
  const checkpoint = parseSharedRecoveryActionCheckpoint(JSON.parse(descriptor));
  const source = parseSharedRecoveryExecutionCheckpointRecord(
    wanted,
    JSON.stringify(checkpoint.checkpoint),
    localDescriptor,
  );
  return Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
}
export async function readSharedRecoveryActionCheckpoint(
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
    ? parseSharedRecoveryActionCheckpointRecord(key, row.descriptor, row.localDescriptor)
    : null;
}
export function inspectSharedRecoveryActionCheckpoint(db: DB, input: LocalRecoveryCheckpointKey) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readSharedRecoveryActionCheckpoint(tx, key));
}
async function requireSources(
  db: DB | Tx | ReadTx,
  binding: SharedRecoveryActionCheckpointBinding,
) {
  const key = keyOf(binding.checkpoint),
    execution = binding.checkpoint.checkpoint;
  const executions = await readSharedRecoveryExecutionCheckpoint(db, key);
  const shared = await readSharedRecoveryCheckpoint(db, key);
  const local = await readLocalRecoveryCheckpoint(db, key);
  if (
    !executions ||
    JSON.stringify(executions.checkpoint) !== JSON.stringify(execution) ||
    JSON.stringify(executions.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError("Trusted execution action source binding is missing or changed");
  if (
    !shared ||
    JSON.stringify(shared.checkpoint) !== JSON.stringify(execution.checkpoint) ||
    JSON.stringify(shared.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError("Trusted shared action source binding is missing or changed");
  if (!local || JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint))
    throw new SharedRecoveryError("Trusted local action source binding is missing or changed");
}
/** Register expectations established by trusted first-record capture, without storing action payload bytes. */
export async function rememberSharedRecoveryActionCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseSharedRecoveryActionCheckpoint(input),
    key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_actions SET descriptor=descriptor WHERE 0`);
  const source = await readSharedRecoveryExecutionCheckpoint(tx, key);
  if (!source) throw new SharedRecoveryError("Trusted execution checkpoint is not registered");
  const binding = Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
  await requireSources(tx, binding);
  const existing = await readSharedRecoveryActionCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(binding))
      throw new SharedRecoveryError(
        "Action checkpoint identity already has different contents or bindings",
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
export function rememberSharedRecoveryActionCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseSharedRecoveryActionCheckpoint(input);
  return withTx(db, (tx) => rememberSharedRecoveryActionCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const binding = await readSharedRecoveryActionCheckpoint(tx, key);
    if (!binding) throw new SharedRecoveryError("Trusted action checkpoint is not registered");
    await requireSources(tx, binding);
    return binding;
  });
}
/** Own transport before catalog reads, hash outside their boundary, then recheck all four original expectations. */
export async function requireStoredSharedRecoveryActionCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  executions: unknown,
  sharedHistory: unknown,
) {
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryActionHistory(input);
  const sourceExecutions = parseSharedRecoveryExecutionHistory(executions);
  const sourceHistory = parseSharedRecoveryHistoryPayload(sharedHistory);
  if (JSON.stringify(payload.checkpoint.checkpoint.identity) !== JSON.stringify(identity))
    throw new SharedRecoveryError("Recovery action checkpoint identity mismatch");
  const key = keyOf(payload),
    binding = await trusted(catalog, key);
  const result = await requireSharedRecoveryActionCheckpoint(
    payload,
    binding.checkpoint,
    identity,
    sourceExecutions,
    sourceHistory,
  );
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(binding))
    throw new SharedRecoveryError("Trusted action checkpoint changed during verification");
  return result;
}
