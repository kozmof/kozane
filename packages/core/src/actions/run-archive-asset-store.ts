/** Trusted run-manifest expectations preserve all seven exact original source bindings. */
import { and, eq, sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../database.js";
import { localRecoveryRunAssetsTable as table } from "../schema.js";
import {
  parseLocalRecoveryCheckpointKey,
  type LocalRecoveryCheckpointKey,
} from "./local-recovery-checkpoint.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  readSharedRecoveryRunArchiveCheckpoint,
  requireSharedRecoveryRunArchiveSources,
} from "./shared-recovery-run-archive-store.js";
import { readRecoveryAssetCheckpoint } from "./recovery-asset-store.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseRunArchiveAssetCheckpoint,
  parseRunArchiveAssetPayload,
  parseRunArchiveAssetSources,
  requireRunArchiveAssetCheckpoint,
  type RunArchiveAssetCheckpoint,
  type RunArchiveAssetSources,
} from "./run-archive-asset-checkpoint.js";

function keyOf(checkpoint: Pick<RunArchiveAssetCheckpoint, "binding">) {
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
export function parseRunArchiveAssetCheckpointRecord(
  key: unknown,
  descriptor: unknown,
): RunArchiveAssetCheckpoint {
  const wanted = parseLocalRecoveryCheckpointKey(key);
  if (typeof descriptor !== "string")
    throw new SharedRecoveryError("Stored run archive asset checkpoint requires TEXT");
  const checkpoint = parseRunArchiveAssetCheckpoint(JSON.parse(descriptor));
  if (JSON.stringify(keyOf(checkpoint)) !== JSON.stringify(wanted))
    throw new SharedRecoveryError("Stored run archive asset checkpoint identity mismatch");
  return checkpoint;
}
export async function readRunArchiveAssetCheckpoint(
  db: DB | Tx | ReadTx,
  input: LocalRecoveryCheckpointKey,
) {
  const key = parseLocalRecoveryCheckpointKey(input),
    row = await db.select({ descriptor: table.descriptor }).from(table).where(where(key)).get();
  return row ? parseRunArchiveAssetCheckpointRecord(key, row.descriptor) : null;
}
export function inspectRunArchiveAssetCheckpoint(db: DB, input: LocalRecoveryCheckpointKey) {
  const key = parseLocalRecoveryCheckpointKey(input);
  return withReadTx(db, (tx) => readRunArchiveAssetCheckpoint(tx, key));
}
async function requireSources(db: DB | Tx | ReadTx, checkpoint: RunArchiveAssetCheckpoint) {
  const key = keyOf(checkpoint),
    runs = await readSharedRecoveryRunArchiveCheckpoint(db, key),
    assets = await readRecoveryAssetCheckpoint(db, key);
  if (!runs || JSON.stringify(runs) !== JSON.stringify(checkpoint.binding))
    throw new SharedRecoveryError("Trusted run archive asset source binding is missing or changed");
  if (!assets || JSON.stringify(assets) !== JSON.stringify(checkpoint.assetCheckpoint))
    throw new SharedRecoveryError("Trusted current asset source binding is missing or changed");
  await requireSharedRecoveryRunArchiveSources(db, checkpoint.binding);
}
/** Register expectations established by trusted capture. This stores no manifests, payload files or image bytes. */
export async function rememberRunArchiveAssetCheckpointInTx(tx: Tx, input: unknown) {
  const checkpoint = parseRunArchiveAssetCheckpoint(input),
    key = keyOf(checkpoint);
  await tx.run(sql`UPDATE local_recovery_run_assets SET descriptor=descriptor WHERE 0`);
  await requireSources(tx, checkpoint);
  const existing = await readRunArchiveAssetCheckpoint(tx, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(checkpoint))
      throw new SharedRecoveryError(
        "Run archive asset checkpoint identity already has different contents or bindings",
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
export function rememberRunArchiveAssetCheckpoint(db: DB, input: unknown) {
  const checkpoint = parseRunArchiveAssetCheckpoint(input);
  return withTx(db, (tx) => rememberRunArchiveAssetCheckpointInTx(tx, checkpoint));
}
async function trusted(db: DB, key: LocalRecoveryCheckpointKey) {
  return withReadTx(db, async (tx) => {
    const checkpoint = await readRunArchiveAssetCheckpoint(tx, key);
    if (!checkpoint)
      throw new SharedRecoveryError("Trusted run archive asset checkpoint is not registered");
    await requireSources(tx, checkpoint);
    return checkpoint;
  });
}
/** Own transport before catalog reads, hash outside their boundary, then recheck all eight original expectations. */
export async function requireStoredRunArchiveAssetCheckpoint(
  catalog: DB,
  input: unknown,
  expected: LocalRecoveryIdentity,
  contents: RunArchiveAssetSources,
) {
  const identity = parseLocalRecoveryIdentity(expected),
    payload = parseRunArchiveAssetPayload(input),
    source = parseRunArchiveAssetSources(contents);
  if (JSON.stringify(payload.binding.localCheckpoint.identity) !== JSON.stringify(identity))
    throw new SharedRecoveryError("Run archive asset checkpoint identity mismatch");
  const key = keyOf(payload),
    checkpoint = await trusted(catalog, key);
  const result = await requireRunArchiveAssetCheckpoint(payload, checkpoint, identity, source);
  if (JSON.stringify(await trusted(catalog, key)) !== JSON.stringify(checkpoint))
    throw new SharedRecoveryError(
      "Trusted run archive asset checkpoint changed during verification",
    );
  return result;
}
