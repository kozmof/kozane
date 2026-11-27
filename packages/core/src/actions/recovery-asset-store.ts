/** Trusted asset expectations survive independently of their original checkpoint catalogs. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../database.js";
import { localRecoveryAssetsTable as table } from "../schema.js";
import {
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
} from "./local-recovery-checkpoint.js";
import { readLocalRecoveryCheckpoint } from "./local-recovery-store.js";
import { readSharedRecoveryCheckpoint } from "./shared-recovery-store.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseLocalRecoveryIdentity,
  parseLocalRecoverySnapshot,
  type LocalRecoveryIdentity,
} from "./local-recovery.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import {
  parseRecoveryAssetCheckpoint,
  parseRecoveryAssetPayload,
  requireRecoveryAssetCheckpoint,
  type RecoveryAssetCheckpoint,
} from "./recovery-asset-checkpoint.js";

function where(key: LocalRecoveryCheckpointKey) {
  return and(
    eq(table.workspaceId, key.workspaceId),
    eq(table.deviceId, key.deviceId),
    eq(table.epochId, key.epochId),
    eq(table.checkpointId, key.checkpointId),
  );
}
function keyOf(checkpoint: Pick<RecoveryAssetCheckpoint, "binding">) {
  const { workspaceId, deviceId, epochId, checkpointId } = checkpoint.binding.checkpoint.identity;
  return { workspaceId, deviceId, epochId, checkpointId };
}
/** Row parsing permits orphaned historical metadata without authorizing payload loading. */
export function parseRecoveryAssetCheckpointRecord(
  key: unknown,
  descriptor: unknown,
): RecoveryAssetCheckpoint {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored asset checkpoint requires TEXT");
  const checkpoint = parseRecoveryAssetCheckpoint(JSON.parse(descriptor));
  if (JSON.stringify(keyOf(checkpoint)) !== JSON.stringify(wanted))
    throw new SharedRecoveryError("Stored asset checkpoint identity mismatch");
  return checkpoint;
}
export async function readRecoveryAssetCheckpoint(
  db: DB | Tx | ReadTx,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input);
  const row = await db.select({ descriptor: table.descriptor }).from(table).where(where(key)).get();
  return row ? parseRecoveryAssetCheckpointRecord(key, row.descriptor) : null;
}
export function inspectRecoveryAssetCheckpoint(db: DB, input: LocalRecoveryCheckpointKey) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readRecoveryAssetCheckpoint(tx, key));
}
async function requireBindings(db: DB | Tx | ReadTx, checkpoint: RecoveryAssetCheckpoint) {
  const key = keyOf(checkpoint);
  const shared = await readSharedRecoveryCheckpoint(db, key);
  const local = await readLocalRecoveryCheckpoint(db, key);
  if (!shared || JSON.stringify(shared) !== JSON.stringify(checkpoint.binding))
    throw new SharedRecoveryError("Trusted shared checkpoint binding is missing or changed");
  if (!local || JSON.stringify(local) !== JSON.stringify(checkpoint.binding.localCheckpoint))
    throw new SharedRecoveryError("Trusted local checkpoint binding is missing or changed");
}

/** Only trusted host preparation should register asset expectations. This stores no manifests or image bytes. */
export async function rememberRecoveryAssetCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseRecoveryAssetCheckpoint(input);
  const key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_assets SET descriptor=descriptor WHERE 0`);
  await requireBindings(tx, checkpoint);
  const existing = await readRecoveryAssetCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(checkpoint))
      throw new SharedRecoveryError(
        "Asset checkpoint identity already has different contents or bindings",
      );
    return { checkpoint: existing, changed: false };
  }
  await tx.insert(table).values({
    ...key,
    descriptor: JSON.stringify(checkpoint),
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
  });
  return { checkpoint, changed: true };
}
export function rememberRecoveryAssetCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseRecoveryAssetCheckpoint(input);
  return withTx(db, (tx) => rememberRecoveryAssetCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const checkpoint = await readRecoveryAssetCheckpoint(tx, key);
    if (!checkpoint) throw new SharedRecoveryError("Trusted asset checkpoint is not registered");
    await requireBindings(tx, checkpoint);
    return checkpoint;
  });
}

/** Resolve trusted asset and source expectations before hashing, then recheck all three live catalogs. */
export async function requireStoredRecoveryAssetCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  contents: Readonly<{ localSnapshot: unknown; sharedHistory: unknown }>,
) {
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseRecoveryAssetPayload(input);
  const source = {
    localSnapshot: parseLocalRecoverySnapshot(contents.localSnapshot),
    sharedHistory: parseSharedRecoveryHistoryPayload(contents.sharedHistory),
  };
  if (JSON.stringify(payload.binding.checkpoint.identity) !== JSON.stringify(identity))
    throw new SharedRecoveryError("Recovery asset checkpoint identity mismatch");
  const key = keyOf(payload);
  const checkpoint = await trusted(catalog, key);
  const result = await requireRecoveryAssetCheckpoint(payload, checkpoint, identity, source);
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(checkpoint))
    throw new SharedRecoveryError("Trusted asset checkpoint changed during verification");
  return result;
}
