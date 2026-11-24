/** Verify protected images against saved recovery payloads and exact original bindings. */
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
  readSharedRecoveryExecutionCheckpoint,
  readSharedRecoveryActionCheckpoint,
  readSharedRecoveryRetainedCheckpoint,
  readRetainedRecoveryAssetCheckpoint,
  readSharedRecoveryActionArchiveCheckpoint,
  readSharedRecoveryRunArchiveCheckpoint,
  readRunArchiveAssetCheckpoint,
  type RecoveryAssetCheckpoint,
  type SharedRecoveryCheckpointBinding,
  type SharedRecoveryHistoryImages,
  type SharedRecoveryExecutionCheckpointBinding,
  type SharedRecoveryActionCheckpointBinding,
  type SharedRecoveryRetainedCheckpointBinding,
  type RetainedRecoveryAssetCheckpoint,
  type SharedRecoveryActionArchiveCheckpointBinding,
  type SharedRecoveryRunArchiveCheckpointBinding,
  type RunArchiveAssetCheckpoint,
} from "@kozane/core/recovery";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import { reserveAssetManifestInTx, readAssetManifest } from "../../db/api/asset-manifest.js";
import { retainImageManifestInTx } from "./image-manifest-retention.js";
import { loadRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { loadRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { loadRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import { loadRegisteredRunArchiveAssetPayload } from "./run-archive-asset-payload.js";
import { loadRegisteredRetainedRecoveryAssetPayload } from "./retained-recovery-asset-payload.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import { observe } from "./recovery-payload-files.js";

export class RecoveryCheckpointImagesError extends Error {
  override readonly name = "RecoveryCheckpointImagesError";
}
type Options = Omit<
  Parameters<typeof loadRegisteredRecoveryAssetPayload>[0],
  "maxBytes" | "executionMaxBytes" | "actionMaxBytes"
> &
  (
    | {
        actionArchiveMaxBytes?: never;
        runArchiveMaxBytes?: never;
        runAssetMaxBytes?: never;
        history: SharedRecoveryHistoryImages;
        assetMaxBytes?: never;
        executionMaxBytes?: never;
        actionMaxBytes?: never;
        retainedMaxBytes?: never;
        retainedAssetMaxBytes?: never;
      }
    | {
        assetMaxBytes: number;
        executionMaxBytes?: number;
        actionMaxBytes?: never;
        retainedMaxBytes?: never;
        retainedAssetMaxBytes?: never;
        actionArchiveMaxBytes?: never;
        runArchiveMaxBytes?: never;
        runAssetMaxBytes?: never;
        history?: never;
      }
    | {
        assetMaxBytes: number;
        executionMaxBytes: number;
        actionMaxBytes: number;
        retainedMaxBytes?: never;
        retainedAssetMaxBytes?: never;
        actionArchiveMaxBytes?: never;
        runArchiveMaxBytes?: never;
        runAssetMaxBytes?: never;
        history?: never;
      }
    | {
        assetMaxBytes: number;
        executionMaxBytes: number;
        actionMaxBytes: number;
        retainedMaxBytes: number;
        retainedAssetMaxBytes: number;
        actionArchiveMaxBytes?: never;
        runArchiveMaxBytes?: never;
        runAssetMaxBytes?: never;
        history?: never;
      }
    | {
        assetMaxBytes: number;
        executionMaxBytes: number;
        actionMaxBytes: number;
        actionArchiveMaxBytes: number;
        runArchiveMaxBytes: number;
        runAssetMaxBytes: number;
        retainedMaxBytes?: never;
        retainedAssetMaxBytes?: never;
        history?: never;
      }
  );
type Prepared = {
  root: string;
  db: Options["db"];
  binding: SharedRecoveryCheckpointBinding;
  manifest: AssetManifest;
  owner: ReturnType<typeof registeredLocalRecoveryImageOwner>;
  assetCheckpoint?: RecoveryAssetCheckpoint;
  executionBinding?: SharedRecoveryExecutionCheckpointBinding;
  actionBinding?: SharedRecoveryActionCheckpointBinding;
  retainedBinding?: SharedRecoveryRetainedCheckpointBinding;
  retainedAssetCheckpoint?: RetainedRecoveryAssetCheckpoint;
  actionArchiveBinding?: SharedRecoveryActionArchiveCheckpointBinding;
  runArchiveBinding?: SharedRecoveryRunArchiveCheckpointBinding;
  runAssetCheckpoint?: RunArchiveAssetCheckpoint;
};
async function prepare(options: Options): Promise<Prepared> {
  const {
    root,
    db,
    createValidationDatabase,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    retainedMaxBytes,
    retainedAssetMaxBytes,
    actionArchiveMaxBytes,
    runArchiveMaxBytes,
    runAssetMaxBytes,
  } = options;
  if (![localMaxBytes, sharedMaxBytes].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new RecoveryCheckpointImagesError("Payload read limits must be positive safe integers");
  const expected = parseLocalRecoveryIdentity(options.expected);
  if (
    actionArchiveMaxBytes !== undefined ||
    runArchiveMaxBytes !== undefined ||
    runAssetMaxBytes !== undefined
  ) {
    if (options.history !== undefined)
      throw new RecoveryCheckpointImagesError(
        "Run archive image coverage requires saved manifests",
      );
    if (retainedMaxBytes !== undefined || retainedAssetMaxBytes !== undefined)
      throw new RecoveryCheckpointImagesError(
        "Choose run archive or selected-root retained coverage",
      );
    if (
      actionArchiveMaxBytes === undefined ||
      runArchiveMaxBytes === undefined ||
      runAssetMaxBytes === undefined ||
      options.assetMaxBytes === undefined ||
      executionMaxBytes === undefined ||
      actionMaxBytes === undefined
    )
      throw new RecoveryCheckpointImagesError(
        "Run archive image coverage requires all saved source read limits",
      );
    const { payload, checkpoint } = await loadRegisteredRunArchiveAssetPayload({
      root,
      db,
      expected,
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      actionArchiveMaxBytes,
      runArchiveMaxBytes,
      assetMaxBytes: options.assetMaxBytes,
      maxBytes: runAssetMaxBytes,
      createValidationDatabase,
    });
    const runArchiveBinding = checkpoint.binding,
      localCheckpoint = runArchiveBinding.localCheckpoint,
      actionArchive = runArchiveBinding.checkpoint.checkpoint,
      original = actionArchive.checkpoint;
    return {
      root,
      db,
      binding: checkpoint.assetCheckpoint.binding,
      manifest: payload.manifest,
      owner: registeredLocalRecoveryImageOwner(expected),
      assetCheckpoint: checkpoint.assetCheckpoint,
      executionBinding: { checkpoint: original.checkpoint, localCheckpoint },
      actionBinding: { checkpoint: original, localCheckpoint },
      actionArchiveBinding: { checkpoint: actionArchive, localCheckpoint },
      runArchiveBinding,
      runAssetCheckpoint: checkpoint,
    };
  }
  if (retainedMaxBytes !== undefined || retainedAssetMaxBytes !== undefined) {
    if (options.history !== undefined)
      throw new RecoveryCheckpointImagesError("Retained image coverage requires saved manifests");
    if (
      retainedMaxBytes === undefined ||
      retainedAssetMaxBytes === undefined ||
      options.assetMaxBytes === undefined ||
      executionMaxBytes === undefined ||
      actionMaxBytes === undefined
    )
      throw new RecoveryCheckpointImagesError(
        "Retained image coverage requires all saved source read limits",
      );
    const { payload, checkpoint } = await loadRegisteredRetainedRecoveryAssetPayload({
      root,
      db,
      expected,
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      retainedMaxBytes,
      assetMaxBytes: options.assetMaxBytes,
      maxBytes: retainedAssetMaxBytes,
      createValidationDatabase,
    });
    const retainedBinding = checkpoint.binding,
      localCheckpoint = retainedBinding.localCheckpoint;
    return {
      root,
      db,
      binding: checkpoint.assetCheckpoint.binding,
      manifest: payload.manifest,
      owner: registeredLocalRecoveryImageOwner(expected),
      assetCheckpoint: checkpoint.assetCheckpoint,
      executionBinding: {
        checkpoint: retainedBinding.checkpoint.checkpoint.checkpoint,
        localCheckpoint,
      },
      actionBinding: { checkpoint: retainedBinding.checkpoint.checkpoint, localCheckpoint },
      retainedBinding,
      retainedAssetCheckpoint: checkpoint,
    };
  }
  if (options.assetMaxBytes !== undefined) {
    if (options.history !== undefined)
      throw new RecoveryCheckpointImagesError("Choose saved manifests or host history");
    const { payload, checkpoint, executionBinding, actionBinding } =
      await loadRegisteredRecoveryAssetPayload({
        root,
        db,
        expected,
        localMaxBytes,
        sharedMaxBytes,
        executionMaxBytes,
        actionMaxBytes,
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
      ...(executionBinding ? { executionBinding } : {}),
      ...(actionBinding ? { actionBinding } : {}),
    };
  }
  if (actionMaxBytes !== undefined)
    throw new RecoveryCheckpointImagesError("Original action coverage requires saved manifests");
  if (executionMaxBytes !== undefined)
    throw new RecoveryCheckpointImagesError("Execution coverage requires saved manifests");
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
  if (prepared.executionBinding) {
    const executions = await readSharedRecoveryExecutionCheckpoint(tx, key);
    if (!executions || JSON.stringify(executions) !== JSON.stringify(prepared.executionBinding))
      throw new RecoveryCheckpointImagesError("Registered execution checkpoint binding changed");
  }
  if (prepared.actionBinding) {
    const actions = await readSharedRecoveryActionCheckpoint(tx, key);
    if (!actions || JSON.stringify(actions) !== JSON.stringify(prepared.actionBinding))
      throw new RecoveryCheckpointImagesError("Registered action checkpoint binding changed");
  }
  if (prepared.retainedBinding) {
    const retained = await readSharedRecoveryRetainedCheckpoint(tx, key);
    if (!retained || JSON.stringify(retained) !== JSON.stringify(prepared.retainedBinding))
      throw new RecoveryCheckpointImagesError("Registered retained checkpoint binding changed");
  }
  if (prepared.retainedAssetCheckpoint) {
    const assets = await readRetainedRecoveryAssetCheckpoint(tx, key);
    if (!assets || JSON.stringify(assets) !== JSON.stringify(prepared.retainedAssetCheckpoint))
      throw new RecoveryCheckpointImagesError(
        "Registered retained asset checkpoint binding changed",
      );
  }
  if (prepared.actionArchiveBinding) {
    const archive = await readSharedRecoveryActionArchiveCheckpoint(tx, key);
    if (!archive || JSON.stringify(archive) !== JSON.stringify(prepared.actionArchiveBinding))
      throw new RecoveryCheckpointImagesError(
        "Registered action archive checkpoint binding changed",
      );
  }
  if (prepared.runArchiveBinding) {
    const archive = await readSharedRecoveryRunArchiveCheckpoint(tx, key);
    if (!archive || JSON.stringify(archive) !== JSON.stringify(prepared.runArchiveBinding))
      throw new RecoveryCheckpointImagesError("Registered run archive checkpoint binding changed");
  }
  if (prepared.runAssetCheckpoint) {
    const assets = await readRunArchiveAssetCheckpoint(tx, key);
    if (!assets || JSON.stringify(assets) !== JSON.stringify(prepared.runAssetCheckpoint))
      throw new RecoveryCheckpointImagesError("Registered run asset checkpoint binding changed");
  }
}
async function requirePayloads(prepared: Prepared) {
  const payloads = [
    { area: "checkpoints" as const, checkpoint: prepared.binding.localCheckpoint },
    { area: "shared-history" as const, checkpoint: prepared.binding.checkpoint },
    ...(prepared.assetCheckpoint
      ? [{ area: "asset-manifests" as const, checkpoint: prepared.assetCheckpoint }]
      : []),
    ...(prepared.executionBinding
      ? [{ area: "executions" as const, checkpoint: prepared.executionBinding.checkpoint }]
      : []),
    ...(prepared.actionBinding
      ? [{ area: "actions" as const, checkpoint: prepared.actionBinding.checkpoint }]
      : []),
    ...(prepared.retainedBinding
      ? [{ area: "retained-history" as const, checkpoint: prepared.retainedBinding.checkpoint }]
      : []),
    ...(prepared.retainedAssetCheckpoint
      ? [
          {
            area: "retained-asset-manifests" as const,
            checkpoint: prepared.retainedAssetCheckpoint,
          },
        ]
      : []),
    ...(prepared.actionArchiveBinding
      ? [{ area: "action-archives" as const, checkpoint: prepared.actionArchiveBinding.checkpoint }]
      : []),
    ...(prepared.runArchiveBinding
      ? [{ area: "run-archives" as const, checkpoint: prepared.runArchiveBinding.checkpoint }]
      : []),
    ...(prepared.runAssetCheckpoint
      ? [{ area: "run-asset-manifests" as const, checkpoint: prepared.runAssetCheckpoint }]
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
    ...(prepared.executionBinding ? { executionBinding: prepared.executionBinding } : {}),
    ...(prepared.actionBinding ? { actionBinding: prepared.actionBinding } : {}),
    ...(prepared.retainedBinding ? { retainedBinding: prepared.retainedBinding } : {}),
    ...(prepared.retainedAssetCheckpoint
      ? { retainedAssetCheckpoint: prepared.retainedAssetCheckpoint }
      : {}),
    ...(prepared.actionArchiveBinding
      ? { actionArchiveBinding: prepared.actionArchiveBinding }
      : {}),
    ...(prepared.runArchiveBinding ? { runArchiveBinding: prepared.runArchiveBinding } : {}),
    ...(prepared.runAssetCheckpoint ? { runAssetCheckpoint: prepared.runAssetCheckpoint } : {}),
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
