/** Content-bound manifests for broader archived runs, original inputs and current recovery assets. */
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
  parseSharedRecoveryRetainedImages,
  type SharedRecoveryRetainedImages,
} from "./shared-recovery-retained-history.js";
import {
  parseSharedRecoveryRunArchive,
  parseSharedRecoveryRunArchiveCheckpoint,
  requireSharedRecoveryRunArchiveCheckpoint,
  sharedRecoveryRunArchiveAssetManifest,
} from "./shared-recovery-run-archive.js";
import {
  parseSharedRecoveryActionArchive,
  sharedRecoveryActionArchiveAssetManifest,
} from "./shared-recovery-action-archive.js";
import {
  parseSharedRecoveryRunArchiveCheckpointRecord,
  type SharedRecoveryRunArchiveCheckpointBinding,
} from "./shared-recovery-run-archive-store.js";
import {
  parseRecoveryAssetCheckpoint,
  parseRecoveryAssetPayload,
  requireRecoveryAssetCheckpoint,
  type RecoveryAssetCheckpoint,
} from "./recovery-asset-checkpoint.js";
import { SharedRecoveryError } from "./shared-recovery.js";

export const RUN_ARCHIVE_ASSET_PAYLOAD_VERSION = 1;
export const RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION = 1;
export interface RunArchiveAssetPayload {
  readonly version: typeof RUN_ARCHIVE_ASSET_PAYLOAD_VERSION;
  readonly binding: SharedRecoveryRunArchiveCheckpointBinding;
  readonly assetCheckpoint: RecoveryAssetCheckpoint;
  readonly history: SharedRecoveryRetainedImages;
  readonly originalImages: AssetManifest;
  readonly manifest: AssetManifest;
}
export interface RunArchiveAssetCheckpoint {
  readonly version: typeof RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION;
  readonly binding: SharedRecoveryRunArchiveCheckpointBinding;
  readonly assetCheckpoint: RecoveryAssetCheckpoint;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface RunArchiveAssetSources {
  readonly localSnapshot: unknown;
  readonly sharedHistory: unknown;
  readonly executions: unknown;
  readonly originalActions: unknown;
  readonly actionArchive: unknown;
  readonly runArchive: unknown;
  readonly currentAssets: unknown;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function parseBinding(input: unknown): SharedRecoveryRunArchiveCheckpointBinding {
  const value = fields(input, ["checkpoint", "localCheckpoint"]),
    checkpoint = parseSharedRecoveryRunArchiveCheckpoint(value.checkpoint),
    local = parseLocalRecoveryCheckpoint(value.localCheckpoint);
  const { workspaceId, deviceId, epochId, checkpointId } = local.identity;
  return parseSharedRecoveryRunArchiveCheckpointRecord(
    { workspaceId, deviceId, epochId, checkpointId },
    JSON.stringify(checkpoint),
    JSON.stringify(local),
  );
}
function requireBinding(
  binding: SharedRecoveryRunArchiveCheckpointBinding,
  assets: RecoveryAssetCheckpoint,
) {
  if (
    !same(assets.binding, {
      checkpoint: binding.checkpoint.checkpoint.checkpoint.checkpoint.checkpoint,
      localCheckpoint: binding.localCheckpoint,
    })
  )
    throw new SharedRecoveryError("Run archive asset source bindings differ");
}
function requireSelection(
  binding: SharedRecoveryRunArchiveCheckpointBinding,
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
    throw new SharedRecoveryError("Run archive asset history selection mismatch");
}
/** Known historical source descriptors remain inspectable metadata. Payloads require the bundled schema. */
export function parseRunArchiveAssetCheckpoint(input: unknown): RunArchiveAssetCheckpoint {
  const value = fields(input, ["version", "binding", "assetCheckpoint", "byteLength", "sha256"]);
  if (
    value.version !== RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed run archive asset checkpoint");
  const binding = parseBinding(value.binding),
    assetCheckpoint = parseRecoveryAssetCheckpoint(value.assetCheckpoint);
  requireBinding(binding, assetCheckpoint);
  return Object.freeze({
    version: RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION,
    binding,
    assetCheckpoint,
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
/** Canonical metadata alone does not establish coverage or authenticity. */
export function parseRunArchiveAssetPayload(input: unknown): RunArchiveAssetPayload {
  const value = fields(input, [
    "version",
    "binding",
    "assetCheckpoint",
    "history",
    "originalImages",
    "manifest",
  ]);
  if (value.version !== RUN_ARCHIVE_ASSET_PAYLOAD_VERSION)
    throw new SharedRecoveryError("Unsupported run archive asset payload version");
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
    throw new SharedRecoveryError("Run archive asset payload omits per-record requirements");
  return Object.freeze({
    version: RUN_ARCHIVE_ASSET_PAYLOAD_VERSION,
    binding,
    assetCheckpoint,
    history,
    originalImages,
    manifest,
  });
}
export function parseRunArchiveAssetSources(input: RunArchiveAssetSources) {
  return {
    localSnapshot: parseLocalRecoverySnapshot(input.localSnapshot),
    sharedHistory: parseSharedRecoveryHistoryPayload(input.sharedHistory),
    executions: parseSharedRecoveryExecutionHistory(input.executions),
    originalActions: parseSharedRecoveryActionHistory(input.originalActions),
    actionArchive: parseSharedRecoveryActionArchive(input.actionArchive),
    runArchive: parseSharedRecoveryRunArchive(input.runArchive),
    currentAssets: parseRecoveryAssetPayload(input.currentAssets),
  };
}
type Sources = ReturnType<typeof parseRunArchiveAssetSources>;
function collect(source: Sources, history: SharedRecoveryRetainedImages, originals: AssetManifest) {
  return mergeAssetManifests([
    source.currentAssets.manifest,
    sharedRecoveryExecutionAssetManifest(source.executions, source.currentAssets.history),
    sharedRecoveryActionAssetManifest(source.originalActions, originals),
    sharedRecoveryActionArchiveAssetManifest(source.actionArchive, originals),
    sharedRecoveryRunArchiveAssetManifest(source.runArchive, history),
  ]);
}
async function requireSources(
  source: Sources,
  binding: SharedRecoveryRunArchiveCheckpointBinding,
  assets: RecoveryAssetCheckpoint,
) {
  const identity = binding.localCheckpoint.identity;
  await requireSharedRecoveryRunArchiveCheckpoint(source.runArchive, binding.checkpoint, identity, {
    actionArchive: source.actionArchive,
    originals: source.originalActions,
    executions: source.executions,
    sharedHistory: source.sharedHistory,
  });
  await requireRecoveryAssetCheckpoint(source.currentAssets, assets, identity, source);
}
async function describe(payload: RunArchiveAssetPayload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseRunArchiveAssetCheckpoint({
      version: RUN_ARCHIVE_ASSET_CHECKPOINT_VERSION,
      binding: payload.binding,
      assetCheckpoint: payload.assetCheckpoint,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
/** Establish expectations from trusted per-run and original-input manifests and both exact source bindings. */
export async function describeRunArchiveAssets(
  input: RunArchiveAssetSources & {
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
    source = parseRunArchiveAssetSources(input);
  requireBinding(binding, assetCheckpoint);
  requireSelection(binding, history);
  const payload = parseRunArchiveAssetPayload({
    version: RUN_ARCHIVE_ASSET_PAYLOAD_VERSION,
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
export async function requireRunArchiveAssetCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: RunArchiveAssetSources,
) {
  const wanted = parseRunArchiveAssetCheckpoint(checkpoint),
    identity = parseLocalRecoveryIdentity(expected),
    payload = parseRunArchiveAssetPayload(input);
  if (
    !same(wanted.binding.localCheckpoint.identity, identity) ||
    !same(payload.binding.localCheckpoint.identity, identity)
  )
    throw new SharedRecoveryError("Run archive asset checkpoint identity mismatch");
  if (
    !same(payload.binding, wanted.binding) ||
    !same(payload.assetCheckpoint, wanted.assetCheckpoint)
  )
    throw new SharedRecoveryError("Run archive asset checkpoint binding mismatch");
  const source = parseRunArchiveAssetSources(contents),
    actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Run archive asset checkpoint content mismatch");
  await requireSources(source, payload.binding, payload.assetCheckpoint);
  if (!same(collect(source, payload.history, payload.originalImages), payload.manifest))
    throw new SharedRecoveryError("Run archive asset payload requirements mismatch");
  return payload;
}
