/** Content-bound manifests for retained runs, originals and the current recovery asset checkpoint. */
import { fields, integer } from "./recovery-action-data.js";
import { parseAssetManifest, mergeAssetManifests, type AssetManifest } from "./asset-manifest.js";
import {
  parseLocalRecoveryIdentity,
  parseLocalRecoverySnapshot,
  type LocalRecoveryIdentity,
} from "./local-recovery.js";
import { parseLocalRecoveryCheckpoint } from "./local-recovery-checkpoint.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import {
  parseSharedRecoveryExecutionHistory,
  sharedRecoveryExecutionAssetManifest,
} from "./shared-recovery-executions.js";
import {
  parseSharedRecoveryActionHistory,
  sharedRecoveryActionAssetManifest,
} from "./shared-recovery-actions.js";
import {
  parseSharedRecoveryRetainedHistory,
  parseSharedRecoveryRetainedCheckpoint,
  parseSharedRecoveryRetainedImages,
  requireSharedRecoveryRetainedCheckpoint,
  sharedRecoveryRetainedAssetManifest,
  type SharedRecoveryRetainedImages,
} from "./shared-recovery-retained-history.js";
import {
  parseSharedRecoveryRetainedCheckpointRecord,
  type SharedRecoveryRetainedCheckpointBinding,
} from "./shared-recovery-retained-store.js";
import {
  parseRecoveryAssetCheckpoint,
  parseRecoveryAssetPayload,
  requireRecoveryAssetCheckpoint,
  type RecoveryAssetCheckpoint,
} from "./recovery-asset-checkpoint.js";
import { SharedRecoveryError } from "./shared-recovery.js";

export const RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION = 1;
export const RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION = 1;
export interface RetainedRecoveryAssetPayload {
  readonly version: typeof RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION;
  readonly binding: SharedRecoveryRetainedCheckpointBinding;
  readonly assetCheckpoint: RecoveryAssetCheckpoint;
  readonly history: SharedRecoveryRetainedImages;
  readonly originalImages: AssetManifest;
  readonly manifest: AssetManifest;
}
export interface RetainedRecoveryAssetCheckpoint {
  readonly version: typeof RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION;
  readonly binding: SharedRecoveryRetainedCheckpointBinding;
  readonly assetCheckpoint: RecoveryAssetCheckpoint;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface RetainedRecoveryAssetSources {
  readonly localSnapshot: unknown;
  readonly sharedHistory: unknown;
  readonly executions: unknown;
  readonly originalActions: unknown;
  readonly retainedHistory: unknown;
  readonly currentAssets: unknown;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function parseBinding(input: unknown): SharedRecoveryRetainedCheckpointBinding {
  const value = fields(input, ["checkpoint", "localCheckpoint"]),
    checkpoint = parseSharedRecoveryRetainedCheckpoint(value.checkpoint),
    local = parseLocalRecoveryCheckpoint(value.localCheckpoint);
  const { workspaceId, deviceId, epochId, checkpointId } = local.identity;
  return parseSharedRecoveryRetainedCheckpointRecord(
    { workspaceId, deviceId, epochId, checkpointId },
    JSON.stringify(checkpoint),
    JSON.stringify(local),
  );
}
function requireBinding(
  binding: SharedRecoveryRetainedCheckpointBinding,
  assets: RecoveryAssetCheckpoint,
) {
  if (
    !same(assets.binding, {
      checkpoint: binding.checkpoint.checkpoint.checkpoint.checkpoint,
      localCheckpoint: binding.localCheckpoint,
    })
  )
    throw new SharedRecoveryError("Retained asset source bindings differ");
}
function requireSelection(
  binding: SharedRecoveryRetainedCheckpointBinding,
  history: SharedRecoveryRetainedImages,
) {
  const selection = binding.checkpoint.selection.effectSets;
  if (
    history.effectSets.length !== selection.length ||
    history.effectSets.some(
      (entry, index) =>
        entry.id !== selection[index].id ||
        entry.history.baseline.id !== selection[index].baselineId ||
        entry.history.effectSets.length !== 1 ||
        entry.history.effectSets[0].id !== selection[index].id,
    )
  )
    throw new SharedRecoveryError("Retained asset history selection mismatch");
}
/** Known historical source descriptors remain inspectable metadata. Payloads require the bundled schema. */
export function parseRetainedRecoveryAssetCheckpoint(
  input: unknown,
): RetainedRecoveryAssetCheckpoint {
  const value = fields(input, ["version", "binding", "assetCheckpoint", "byteLength", "sha256"]);
  if (
    value.version !== RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed retained asset checkpoint");
  const binding = parseBinding(value.binding),
    assetCheckpoint = parseRecoveryAssetCheckpoint(value.assetCheckpoint);
  requireBinding(binding, assetCheckpoint);
  return Object.freeze({
    version: RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION,
    binding,
    assetCheckpoint,
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
/** Canonical metadata alone does not establish coverage or authenticity. */
export function parseRetainedRecoveryAssetPayload(input: unknown): RetainedRecoveryAssetPayload {
  const value = fields(input, [
    "version",
    "binding",
    "assetCheckpoint",
    "history",
    "originalImages",
    "manifest",
  ]);
  if (value.version !== RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION)
    throw new SharedRecoveryError("Unsupported retained asset payload version");
  const binding = parseBinding(value.binding),
    assetCheckpoint = parseRecoveryAssetCheckpoint(value.assetCheckpoint);
  parseLocalRecoveryIdentity(binding.localCheckpoint.identity);
  requireBinding(binding, assetCheckpoint);
  const history = parseSharedRecoveryRetainedImages(value.history),
    originalImages = parseAssetManifest(value.originalImages),
    manifest = parseAssetManifest(value.manifest);
  requireSelection(binding, history);
  const union = mergeAssetManifests([
    manifest,
    originalImages,
    ...history.effectSets.flatMap(({ history }) => [
      history.baseline.manifest,
      ...history.effectSets.map(({ manifest }) => manifest),
    ]),
  ]);
  if (!same(union, manifest))
    throw new SharedRecoveryError("Retained asset payload omits per-record requirements");
  return Object.freeze({
    version: RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION,
    binding,
    assetCheckpoint,
    history,
    originalImages,
    manifest,
  });
}
export function parseRetainedRecoveryAssetSources(input: RetainedRecoveryAssetSources) {
  return {
    localSnapshot: parseLocalRecoverySnapshot(input.localSnapshot),
    sharedHistory: parseSharedRecoveryHistoryPayload(input.sharedHistory),
    executions: parseSharedRecoveryExecutionHistory(input.executions),
    originalActions: parseSharedRecoveryActionHistory(input.originalActions),
    retainedHistory: parseSharedRecoveryRetainedHistory(input.retainedHistory),
    currentAssets: parseRecoveryAssetPayload(input.currentAssets),
  };
}
type Sources = ReturnType<typeof parseRetainedRecoveryAssetSources>;
function collect(source: Sources, history: SharedRecoveryRetainedImages, originals: AssetManifest) {
  return mergeAssetManifests([
    source.currentAssets.manifest,
    sharedRecoveryExecutionAssetManifest(source.executions, source.currentAssets.history),
    sharedRecoveryActionAssetManifest(source.originalActions, originals),
    sharedRecoveryRetainedAssetManifest(source.retainedHistory, history),
  ]);
}
async function requireSources(
  source: Sources,
  binding: SharedRecoveryRetainedCheckpointBinding,
  assets: RecoveryAssetCheckpoint,
) {
  const identity = binding.localCheckpoint.identity;
  await requireSharedRecoveryRetainedCheckpoint(
    source.retainedHistory,
    binding.checkpoint,
    identity,
    source.originalActions,
    source.executions,
    source.sharedHistory,
  );
  await requireRecoveryAssetCheckpoint(source.currentAssets, assets, identity, source);
}
async function describe(payload: RetainedRecoveryAssetPayload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseRetainedRecoveryAssetCheckpoint({
      version: RETAINED_RECOVERY_ASSET_CHECKPOINT_VERSION,
      binding: payload.binding,
      assetCheckpoint: payload.assetCheckpoint,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
/** Establish expectations from trusted per-run and original-input manifests and both exact source bindings. */
export async function describeRetainedRecoveryAssets(
  input: RetainedRecoveryAssetSources & {
    binding: unknown;
    assetCheckpoint: unknown;
    history: unknown;
    originalImages: unknown;
  },
) {
  const binding = parseBinding(input.binding),
    assetCheckpoint = parseRecoveryAssetCheckpoint(input.assetCheckpoint),
    history = parseSharedRecoveryRetainedImages(input.history),
    originalImages = parseAssetManifest(input.originalImages),
    source = parseRetainedRecoveryAssetSources(input);
  requireBinding(binding, assetCheckpoint);
  requireSelection(binding, history);
  const payload = parseRetainedRecoveryAssetPayload({
    version: RETAINED_RECOVERY_ASSET_PAYLOAD_VERSION,
    binding,
    assetCheckpoint,
    history,
    originalImages,
    manifest: collect(source, history, originalImages),
  });
  await requireSources(source, binding, assetCheckpoint);
  return describe(payload);
}
/** Own all sources before hashing and require independently trusted metadata and exact per-run coverage. */
export async function requireRetainedRecoveryAssetCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: RetainedRecoveryAssetSources,
) {
  const wanted = parseRetainedRecoveryAssetCheckpoint(checkpoint),
    identity = parseLocalRecoveryIdentity(expected),
    payload = parseRetainedRecoveryAssetPayload(input);
  if (
    !same(wanted.binding.localCheckpoint.identity, identity) ||
    !same(payload.binding.localCheckpoint.identity, identity)
  )
    throw new SharedRecoveryError("Retained asset checkpoint identity mismatch");
  if (
    !same(payload.binding, wanted.binding) ||
    !same(payload.assetCheckpoint, wanted.assetCheckpoint)
  )
    throw new SharedRecoveryError("Retained asset checkpoint binding mismatch");
  const source = parseRetainedRecoveryAssetSources(contents),
    actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Retained asset checkpoint content mismatch");
  await requireSources(source, payload.binding, payload.assetCheckpoint);
  if (!same(collect(source, payload.history, payload.originalImages), payload.manifest))
    throw new SharedRecoveryError("Retained asset payload requirements mismatch");
  return payload;
}
