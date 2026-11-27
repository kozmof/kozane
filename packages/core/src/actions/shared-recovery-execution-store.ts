/** Trusted selected-execution expectations preserve both original source bindings. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoveryExecutionsTable as table } from "../schema.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpoint,
} from "./local-recovery-checkpoint.js";
import { readLocalRecoveryCheckpoint } from "./local-recovery-store.js";
import {
  readSharedRecoveryCheckpoint,
  parseSharedRecoveryCheckpointRecord,
} from "./shared-recovery-store.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseSharedRecoveryExecutionCheckpoint,
  parseSharedRecoveryExecutionHistory,
  requireSharedRecoveryExecutionCheckpoint,
  type SharedRecoveryExecutionCheckpoint,
} from "./shared-recovery-executions.js";

export interface SharedRecoveryExecutionCheckpointBinding {
  readonly checkpoint: SharedRecoveryExecutionCheckpoint;
  readonly localCheckpoint: LocalRecoveryCheckpoint;
}
function keyOf(checkpoint: Pick<SharedRecoveryExecutionCheckpoint, "checkpoint">) {
  const { workspaceId, deviceId, epochId, checkpointId } = checkpoint.checkpoint.identity;
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
/** Metadata remains inspectable after a source catalog disappears. No timestamps pass through Date. */
export function parseSharedRecoveryExecutionCheckpointRecord(
  key: unknown,
  descriptor: unknown,
  localDescriptor: unknown,
): SharedRecoveryExecutionCheckpointBinding {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored execution checkpoint requires TEXT");
  const checkpoint = parseSharedRecoveryExecutionCheckpoint(JSON.parse(descriptor));
  const source = parseSharedRecoveryCheckpointRecord(
    wanted,
    JSON.stringify(checkpoint.checkpoint),
    localDescriptor,
  );
  return Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
}
export async function readSharedRecoveryExecutionCheckpoint(
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
    ? parseSharedRecoveryExecutionCheckpointRecord(key, row.descriptor, row.localDescriptor)
    : null;
}
export function inspectSharedRecoveryExecutionCheckpoint(
  db: DB,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readSharedRecoveryExecutionCheckpoint(tx, key));
}
async function requireSources(
  db: DB | Tx | ReadTx,
  binding: SharedRecoveryExecutionCheckpointBinding,
) {
  const key = keyOf(binding.checkpoint);
  const shared = await readSharedRecoveryCheckpoint(db, key);
  const local = await readLocalRecoveryCheckpoint(db, key);
  if (
    !shared ||
    JSON.stringify(shared.checkpoint) !== JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(shared.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryError("Trusted shared execution source binding is missing or changed");
  if (!local || JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint))
    throw new SharedRecoveryError("Trusted local execution source binding is missing or changed");
}
/** Register only a descriptor established by trusted completed scope capture. No execution bytes are stored. */
export async function rememberSharedRecoveryExecutionCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseSharedRecoveryExecutionCheckpoint(input),
    key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_executions SET descriptor=descriptor WHERE 0`);
  const source = await readSharedRecoveryCheckpoint(tx, key);
  if (!source) throw new SharedRecoveryError("Trusted shared checkpoint is not registered");
  const binding = Object.freeze({ checkpoint, localCheckpoint: source.localCheckpoint });
  await requireSources(tx, binding);
  const existing = await readSharedRecoveryExecutionCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(binding))
      throw new SharedRecoveryError(
        "Execution checkpoint identity already has different contents or bindings",
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
export function rememberSharedRecoveryExecutionCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseSharedRecoveryExecutionCheckpoint(input);
  return withTx(db, (tx) => rememberSharedRecoveryExecutionCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const binding = await readSharedRecoveryExecutionCheckpoint(tx, key);
    if (!binding) throw new SharedRecoveryError("Trusted execution checkpoint is not registered");
    await requireSources(tx, binding);
    return binding;
  });
}
/** Resolve expectations from live catalogs, verify owned payloads outside the read boundary and recheck every binding. */
export async function requireStoredSharedRecoveryExecutionCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  sharedHistory: unknown,
) {
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryExecutionHistory(input);
  const source = parseSharedRecoveryHistoryPayload(sharedHistory);
  if (JSON.stringify(payload.checkpoint.identity) !== JSON.stringify(identity))
    throw new SharedRecoveryError("Recovery execution checkpoint identity mismatch");
  const key = keyOf(payload);
  const binding = await trusted(catalog, key);
  const result = await requireSharedRecoveryExecutionCheckpoint(
    payload,
    binding.checkpoint,
    identity,
    source,
  );
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(binding))
    throw new SharedRecoveryError("Trusted execution checkpoint changed during verification");
  return result;
}
