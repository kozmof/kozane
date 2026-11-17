/** Trusted local descriptor bindings. Registration stores metadata, never history payloads or assets. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoverySharedHistoryTable as table } from "../schema.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseLocalRecoveryCheckpointRecord,
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpoint,
} from "./local-recovery-checkpoint.js";
import { readLocalRecoveryCheckpoint } from "./local-recovery-store.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseSharedRecoveryCheckpoint,
  parseSharedRecoveryHistoryPayload,
  validateSharedRecoveryCheckpoint,
  type SharedRecoveryCheckpoint,
} from "./shared-recovery-checkpoint.js";

export interface SharedRecoveryCheckpointBinding {
  readonly checkpoint: SharedRecoveryCheckpoint;
  readonly localCheckpoint: LocalRecoveryCheckpoint;
}
function where(key: LocalRecoveryCheckpointKey) {
  return and(
    eq(table.workspaceId, key.workspaceId),
    eq(table.deviceId, key.deviceId),
    eq(table.epochId, key.epochId),
    eq(table.checkpointId, key.checkpointId),
  );
}
function bound(
  checkpoint: SharedRecoveryCheckpoint,
  localCheckpoint: LocalRecoveryCheckpoint,
): SharedRecoveryCheckpointBinding {
  if (
    JSON.stringify(checkpoint.identity) !== JSON.stringify(localCheckpoint.identity) ||
    checkpoint.selection.baselineId !== localCheckpoint.selection.baselineId ||
    JSON.stringify(checkpoint.selection.effectSets.map(({ id }) => id)) !==
      JSON.stringify(localCheckpoint.selection.effectSetIds)
  )
    throw new SharedRecoveryError(
      "Shared history does not match local checkpoint identity or selection",
    );
  return Object.freeze({ checkpoint, localCheckpoint });
}

/** Read metadata without converting timestamps or treating stored payload rows as trusted expectations. */
export function parseSharedRecoveryCheckpointRecord(
  key: unknown,
  descriptor: unknown,
  localDescriptor: unknown,
): SharedRecoveryCheckpointBinding {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored shared checkpoint requires TEXT");
  const checkpoint = parseSharedRecoveryCheckpoint(JSON.parse(descriptor));
  const localCheckpoint = parseLocalRecoveryCheckpointRecord(wanted, localDescriptor);
  return bound(checkpoint, localCheckpoint);
}
export async function readSharedRecoveryCheckpoint(
  db: DB | Tx | ReadTx,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  const row = await db
    .select({ descriptor: table.descriptor, localDescriptor: table.localDescriptor })
    .from(table)
    .where(where(key))
    .get();
  return row ? parseSharedRecoveryCheckpointRecord(key, row.descriptor, row.localDescriptor) : null;
}
export function inspectSharedRecoveryCheckpoint(db: DB, input: LocalRecoveryCheckpointKey) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readSharedRecoveryCheckpoint(tx, key));
}

/** Register only the descriptor from trusted host history capture, against an already registered local snapshot. */
export async function rememberSharedRecoveryCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseSharedRecoveryCheckpoint(input);
  const { workspaceId, deviceId, epochId, checkpointId } = checkpoint.identity;
  const key = { workspaceId, deviceId, epochId, checkpointId };
  await tx.run(sql`UPDATE local_recovery_shared_history SET descriptor=descriptor WHERE 0`);
  const localCheckpoint = await readLocalRecoveryCheckpoint(tx, key);
  if (!localCheckpoint) throw new SharedRecoveryError("Trusted local checkpoint is not registered");
  const binding = bound(checkpoint, localCheckpoint);
  const existing = await readSharedRecoveryCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(binding))
      throw new SharedRecoveryError(
        "Shared checkpoint identity already has different contents or local binding",
      );
    return { binding: existing, changed: false };
  }
  await tx
    .insert(table)
    .values({
      ...key,
      descriptor: JSON.stringify(checkpoint),
      localDescriptor: JSON.stringify(localCheckpoint),
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    });
  return { binding, changed: true };
}
export function rememberSharedRecoveryCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseSharedRecoveryCheckpoint(input);
  return withTx(db, (tx) => rememberSharedRecoveryCheckpointInTx(tx, checkpoint));
}
async function trustedBinding(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const binding = await readSharedRecoveryCheckpoint(tx, key);
    if (!binding) throw new SharedRecoveryError("Trusted shared checkpoint is not registered");
    const current = await readLocalRecoveryCheckpoint(tx, key);
    if (!current || JSON.stringify(current) !== JSON.stringify(binding.localCheckpoint))
      throw new SharedRecoveryError("Trusted local checkpoint binding changed");
    return binding;
  });
}

/** Resolve both retained expectations before hashing or SQL allocation, then recheck their bindings. */
export async function validateStoredSharedRecoveryCheckpoint(
  trustedCatalog: DB,
  createDatabase: () => Promise<DB>,
  input: unknown,
  expected: LocalRecoveryIdentity,
) {
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryHistoryPayload(input);
  if (JSON.stringify(payload.identity) !== JSON.stringify(identity))
    throw new SharedRecoveryError("Shared recovery checkpoint identity mismatch");
  const { workspaceId, deviceId, epochId, checkpointId } = identity;
  const key = { workspaceId, deviceId, epochId, checkpointId };
  const binding = await trustedBinding(trustedCatalog, key);
  const result = await validateSharedRecoveryCheckpoint(
    createDatabase,
    payload,
    binding.checkpoint,
    identity,
  );
  if (JSON.stringify(await trustedBinding(trustedCatalog, key)) !== JSON.stringify(binding))
    throw new SharedRecoveryError("Trusted shared checkpoint binding changed during validation");
  return result;
}
