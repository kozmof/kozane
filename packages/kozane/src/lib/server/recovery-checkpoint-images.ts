/** Verify image protection against both saved checkpoint payloads. Complete bundle publication is separate. */
import { withTx, type Tx } from "../../db/database.js";
import type { AssetManifest } from "@kozane/core";
import {
  parseLocalRecoveryIdentity,
  parseSharedRecoveryHistoryImages,
  sharedRecoveryAssetManifest,
  localRecoveryAssetManifest,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  readRecoveryAssetCheckpoint,
  type RecoveryAssetCheckpoint,
  type SharedRecoveryCheckpointBinding,
  type SharedRecoveryHistoryImages,
} from "@kozane/core/recovery";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import { reserveAssetManifestInTx, readAssetManifest } from "../../db/api/asset-manifest.js";
import { retainImageManifestInTx } from "./image-manifest-retention.js";
import { loadRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { loadRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { loadRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import { observe } from "./recovery-payload-files.js";

export class RecoveryCheckpointImagesError extends Error {
  override readonly name = "RecoveryCheckpointImagesError";
}
type Options = Omit<Parameters<typeof loadRegisteredRecoveryAssetPayload>[0], "maxBytes"> &
  (
    | { history: SharedRecoveryHistoryImages; assetMaxBytes?: never }
    | { assetMaxBytes: number; history?: never }
  );
type Prepared = {
  root: string;
  db: Options["db"];
  binding: SharedRecoveryCheckpointBinding;
  manifest: AssetManifest;
  owner: ReturnType<typeof registeredLocalRecoveryImageOwner>;
  assetCheckpoint?: RecoveryAssetCheckpoint;
};
async function prepare(options: Options): Promise<Prepared> {
  const { root, db, createValidationDatabase, localMaxBytes, sharedMaxBytes } = options;
  if (![localMaxBytes, sharedMaxBytes].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new RecoveryCheckpointImagesError("Payload read limits must be positive safe integers");
  const expected = parseLocalRecoveryIdentity(options.expected);
  if (options.assetMaxBytes !== undefined) {
    if (options.history !== undefined)
      throw new RecoveryCheckpointImagesError("Choose saved manifests or host history");
    const { payload, checkpoint } = await loadRegisteredRecoveryAssetPayload({
      root,
      db,
      expected,
      localMaxBytes,
      sharedMaxBytes,
      createValidationDatabase,
      maxBytes: options.assetMaxBytes,
    });
    return {
      root,
      db,
      binding: checkpoint.binding,
      manifest: payload.manifest,
      owner: registeredLocalRecoveryImageOwner(expected),
      assetCheckpoint: checkpoint,
    };
  }
  const history = parseSharedRecoveryHistoryImages(options.history);
  const local = await loadRegisteredLocalRecoveryPayload({
    root,
    db,
    expected,
    maxBytes: localMaxBytes,
    createValidationDatabase,
  });
  const shared = await loadRegisteredSharedRecoveryPayload({
    root,
    db,
    expected,
    maxBytes: sharedMaxBytes,
    createValidationDatabase,
  });
  if (JSON.stringify(local.checkpoint) !== JSON.stringify(shared.binding.localCheckpoint))
    throw new RecoveryCheckpointImagesError(
      "Saved payloads do not have the same local checkpoint binding",
    );
  const sharedManifest = sharedRecoveryAssetManifest(shared.payload, history);
  const manifest = localRecoveryAssetManifest(local.snapshot, [sharedManifest]);
  return {
    root,
    db,
    binding: shared.binding,
    manifest,
    owner: registeredLocalRecoveryImageOwner(expected),
  };
}
async function requireBinding(tx: Tx, prepared: Prepared) {
  const { workspaceId, deviceId, epochId, checkpointId } = prepared.binding.checkpoint.identity;
  const key = { workspaceId, deviceId, epochId, checkpointId };
  const binding = await readSharedRecoveryCheckpoint(tx, key);
  const local = await readLocalRecoveryCheckpoint(tx, key);
  if (
    !binding ||
    JSON.stringify(binding) !== JSON.stringify(prepared.binding) ||
    !local ||
    JSON.stringify(local) !== JSON.stringify(prepared.binding.localCheckpoint)
  )
    throw new RecoveryCheckpointImagesError("Registered checkpoint binding changed");
  if (prepared.assetCheckpoint) {
    const assets = await readRecoveryAssetCheckpoint(tx, key);
    if (!assets || JSON.stringify(assets) !== JSON.stringify(prepared.assetCheckpoint))
      throw new RecoveryCheckpointImagesError("Registered asset checkpoint binding changed");
  }
}
async function requirePayloads(prepared: Prepared) {
  const payloads = [
    { area: "checkpoints" as const, checkpoint: prepared.binding.localCheckpoint },
    { area: "shared-history" as const, checkpoint: prepared.binding.checkpoint },
    ...(prepared.assetCheckpoint
      ? [{ area: "asset-manifests" as const, checkpoint: prepared.assetCheckpoint }]
      : []),
  ];
  for (const { area, checkpoint } of payloads) {
    const evidence = await observe(prepared.root, checkpoint, area);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new RecoveryCheckpointImagesError(`Saved ${area} payload needs review`);
  }
}
function result(prepared: Prepared, state: "pending" | "retained", changed: boolean) {
  return Object.freeze({
    binding: prepared.binding,
    owner: prepared.owner,
    manifest: prepared.manifest,
    state,
    changed,
    ...(prepared.assetCheckpoint ? { assetCheckpoint: prepared.assetCheckpoint } : {}),
  });
}
async function reserve(prepared: Prepared) {
  return withTx(prepared.db, async (tx) => {
    await lockImageAssetWork(tx);
    await requireBinding(tx, prepared);
    await requirePayloads(prepared);
    const reserved = await reserveAssetManifestInTx(tx, prepared.owner, prepared.manifest);
    if (reserved.record.state === "released")
      throw new RecoveryCheckpointImagesError("Checkpoint image owner was released");
    await requirePayloads(prepared);
    await requireBinding(tx, prepared);
    return result(prepared, reserved.record.state, reserved.changed);
  });
}

/** Validate saved payloads and manifest coverage, then commit protection before image reads. */
export async function reserveRegisteredRecoveryCheckpointImages(options: Options) {
  return reserve(await prepare(options));
}

/** Failure retains earlier protection. Required payloads and catalog bindings are checked under the image lock. */
export async function retainRegisteredRecoveryCheckpointImages(options: Options) {
  const prepared = await prepare(options);
  const reserved = await reserve(prepared);
  return withTx(prepared.db, async (tx) => {
    await lockImageAssetWork(tx);
    await requireBinding(tx, prepared);
    await requirePayloads(prepared);
    const current = await readAssetManifest(tx, prepared.owner);
    if (JSON.stringify(current.manifest) !== JSON.stringify(prepared.manifest))
      throw new RecoveryCheckpointImagesError("Checkpoint image manifest changed");
    const retained = await retainImageManifestInTx(tx, prepared.root, prepared.owner);
    await requirePayloads(prepared);
    await requireBinding(tx, prepared);
    return result(prepared, "retained", reserved.changed || retained.changed);
  });
}
