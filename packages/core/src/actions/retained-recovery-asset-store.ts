/** Trusted retained-manifest expectations preserve all six exact original source bindings. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../database.js";
import { localRecoveryRetainedAssetsTable as table } from "../schema.js";
import {
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
} from "./local-recovery-checkpoint.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  readSharedRecoveryRetainedCheckpoint,
  requireSharedRecoveryRetainedSources,
} from "./shared-recovery-retained-store.js";
import { readRecoveryAssetCheckpoint } from "./recovery-asset-store.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseRetainedRecoveryAssetCheckpoint,
  parseRetainedRecoveryAssetPayload,
  parseRetainedRecoveryAssetSources,
  requireRetainedRecoveryAssetCheckpoint,
  type RetainedRecoveryAssetCheckpoint,
  type RetainedRecoveryAssetSources,
} from "./retained-recovery-asset-checkpoint.js";

function keyOf(checkpoint: Pick<RetainedRecoveryAssetCheckpoint, "binding">) {
  const { workspaceId, deviceId, epochId, checkpointId } =
    checkpoint.binding.localCheckpoint.identity;
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
/** Inspect coherent historical or orphaned metadata without converting registration timestamps. */
export function parseRetainedRecoveryAssetCheckpointRecord(
  key: unknown,
  descriptor: unknown,
): RetainedRecoveryAssetCheckpoint {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored retained asset checkpoint requires TEXT");
  const checkpoint = parseRetainedRecoveryAssetCheckpoint(JSON.parse(descriptor));
  if (JSON.stringify(keyOf(checkpoint)) !== JSON.stringify(wanted))
    throw new SharedRecoveryError("Stored retained asset checkpoint identity mismatch");
  return checkpoint;
}
export async function readRetainedRecoveryAssetCheckpoint(
  db: DB | Tx | ReadTx,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input),
    row = await db.select({ descriptor: table.descriptor }).from(table).where(where(key)).get();
  return row ? parseRetainedRecoveryAssetCheckpointRecord(key, row.descriptor) : null;
}
export function inspectRetainedRecoveryAssetCheckpoint(db: DB, input: LocalRecoveryCheckpointKey) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readRetainedRecoveryAssetCheckpoint(tx, key));
}
async function requireSources(db: DB | Tx | ReadTx, checkpoint: RetainedRecoveryAssetCheckpoint) {
  const key = keyOf(checkpoint),
    retained = await readSharedRecoveryRetainedCheckpoint(db, key),
    assets = await readRecoveryAssetCheckpoint(db, key);
  if (!retained || JSON.stringify(retained) !== JSON.stringify(checkpoint.binding))
    throw new SharedRecoveryError(
      "Trusted retained history asset source binding is missing or changed",
    );
  if (!assets || JSON.stringify(assets) !== JSON.stringify(checkpoint.assetCheckpoint))
    throw new SharedRecoveryError("Trusted current asset source binding is missing or changed");
  await requireSharedRecoveryRetainedSources(db, checkpoint.binding);
}
/** Register expectations established by trusted capture. This stores no manifests, payload files or image bytes. */
export async function rememberRetainedRecoveryAssetCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseRetainedRecoveryAssetCheckpoint(input),
    key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_retained_assets SET descriptor=descriptor WHERE 0`);
  await requireSources(tx, checkpoint);
  const existing = await readRetainedRecoveryAssetCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(checkpoint))
      throw new SharedRecoveryError(
        "Retained asset checkpoint identity already has different contents or bindings",
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
export function rememberRetainedRecoveryAssetCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseRetainedRecoveryAssetCheckpoint(input);
  return withTx(db, (tx) => rememberRetainedRecoveryAssetCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const checkpoint = await readRetainedRecoveryAssetCheckpoint(tx, key);
    if (!checkpoint)
      throw new SharedRecoveryError("Trusted retained asset checkpoint is not registered");
    await requireSources(tx, checkpoint);
    return checkpoint;
  });
}
/** Own transport before catalog reads, hash outside their boundary, then recheck all seven original expectations. */
export async function requireStoredRetainedRecoveryAssetCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  contents: RetainedRecoveryAssetSources,
) {
  const identity = parseLocalRecoveryIdentity(expected),
    payload = parseRetainedRecoveryAssetPayload(input),
    source = parseRetainedRecoveryAssetSources(contents);
  if (JSON.stringify(payload.binding.localCheckpoint.identity) !== JSON.stringify(identity))
    throw new SharedRecoveryError("Retained asset checkpoint identity mismatch");
  const key = keyOf(payload),
    checkpoint = await trusted(catalog, key);
  const result = await requireRetainedRecoveryAssetCheckpoint(
    payload,
    checkpoint,
    identity,
    source,
  );
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(checkpoint))
    throw new SharedRecoveryError("Trusted retained asset checkpoint changed during verification");
  return result;
}
