/** Protect checkpoint images before verification. This does not retain history or publish a bundle. */
import { createHash } from "node:crypto";
import {
  localRecoveryAssetManifest,
  parseSharedRecoveryHistoryImages,
  SharedRecoveryError,
  type SharedRecoveryHistoryImages,
  parseLocalRecoveryIdentity,
  readLocalRecoveryCheckpoint,
  type LocalRecoveryCheckpoint,
  type LocalRecoveryIdentity,
} from "@kozane/core/recovery";
import { withTx, type Tx } from "../../db/database.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import { reserveAssetManifestInTx, readAssetManifest } from "../../db/api/asset-manifest.js";
import { retainImageManifestInTx } from "./image-manifest-retention.js";
import {
  loadRegisteredLocalRecoveryPayload,
  LocalRecoveryPayloadError,
} from "./local-recovery-payload.js";

export type LocalRecoveryHistoryImages = SharedRecoveryHistoryImages;
type Options = Parameters<typeof loadRegisteredLocalRecoveryPayload>[0] & {
  history: LocalRecoveryHistoryImages;
};

/** One immutable ledger owner per catalog key, independent of caller-chosen path or owner IDs. */
export function registeredLocalRecoveryImageOwner(input: LocalRecoveryIdentity) {
  const { workspaceId, deviceId, epochId, checkpointId } = parseLocalRecoveryIdentity(input);
  const digest = createHash("sha256")
    .update(JSON.stringify([workspaceId, deviceId, epochId, checkpointId]))
    .digest("hex");
  return Object.freeze({ kind: "recovery" as const, id: `local-checkpoint-v1:${digest}` });
}

async function prepare(options: Options) {
  // Copy host history before the first await, including manifests and materialization order.
  let history: SharedRecoveryHistoryImages;
  try {
    history = parseSharedRecoveryHistoryImages(options.history);
  } catch (cause) {
    if (cause instanceof SharedRecoveryError)
      throw new LocalRecoveryPayloadError(cause.message, { cause });
    throw cause;
  }
  const { db, root } = options;
  const { snapshot, checkpoint } = await loadRegisteredLocalRecoveryPayload(options);
  const selection = checkpoint.selection;
  if (
    history.baseline.id !== selection.baselineId ||
    history.effectSets.length !== selection.effectSetIds.length ||
    history.effectSets.some((entry, index) => entry.id !== selection.effectSetIds[index])
  )
    throw new LocalRecoveryPayloadError("History images do not match checkpoint selection");
  const manifest = localRecoveryAssetManifest(snapshot, [
    history.baseline.manifest,
    ...history.effectSets.map((entry) => entry.manifest),
  ]);
  return {
    db,
    root,
    checkpoint,
    manifest,
    owner: registeredLocalRecoveryImageOwner(checkpoint.identity),
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function requireBinding(tx: Tx, checkpoint: LocalRecoveryCheckpoint) {
  const { workspaceId, deviceId, epochId, checkpointId } = checkpoint.identity;
  const current = await readLocalRecoveryCheckpoint(tx, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!current || JSON.stringify(current) !== JSON.stringify(checkpoint))
    throw new LocalRecoveryPayloadError("Registered checkpoint binding changed");
}
function result(prepared: Prepared, state: "pending" | "retained", changed: boolean) {
  return Object.freeze({
    checkpoint: prepared.checkpoint,
    owner: prepared.owner,
    manifest: prepared.manifest,
    state,
    changed,
  });
}
async function reserve(prepared: Prepared) {
  return withTx(prepared.db, async (tx) => {
    await lockImageAssetWork(tx);
    await requireBinding(tx, prepared.checkpoint);
    const reserved = await reserveAssetManifestInTx(tx, prepared.owner, prepared.manifest);
    // The ledger refuses released owners, including retries after explicit retirement.
    if (reserved.record.state === "released")
      throw new LocalRecoveryPayloadError("Checkpoint image owner was released");
    return result(prepared, reserved.record.state, reserved.changed);
  });
}

/** Host history must come from complete retained records. Earlier pins stay until this commits. */
export async function reserveRegisteredLocalRecoveryImages(options: Options) {
  return reserve(await prepare(options));
}

/** Commit pending protection before reading image bytes. Failure never releases that protection. */
export async function retainRegisteredLocalRecoveryImages(options: Options) {
  const prepared = await prepare(options);
  const reserved = await reserve(prepared);
  return withTx(prepared.db, async (tx) => {
    await lockImageAssetWork(tx);
    await requireBinding(tx, prepared.checkpoint);
    const current = await readAssetManifest(tx, prepared.owner);
    if (JSON.stringify(current.manifest) !== JSON.stringify(prepared.manifest))
      throw new LocalRecoveryPayloadError("Checkpoint image manifest changed");
    const retained = await retainImageManifestInTx(tx, prepared.root, prepared.owner);
    await requireBinding(tx, prepared.checkpoint);
    return result(prepared, "retained", reserved.changed || retained.changed);
  });
}
