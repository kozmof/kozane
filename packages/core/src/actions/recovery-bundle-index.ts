/** One immutable inventory of recovery payloads and their complete image requirements. */
import { fields, array, integer } from "./recovery-action-data.js";
import { parseAssetManifest, type AssetManifest } from "./asset-manifest.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseRunArchiveAssetCheckpoint,
  parseRunArchiveAssetPayload,
  parseRunArchiveAssetSources,
  requireRunArchiveAssetCheckpoint,
  type RunArchiveAssetCheckpoint,
  type RunArchiveAssetSources,
} from "./run-archive-asset-checkpoint.js";
import { SharedRecoveryError } from "./shared-recovery.js";

export const RECOVERY_BUNDLE_INDEX_VERSION = 1;
export const RECOVERY_BUNDLE_CHECKPOINT_VERSION = 1;
export type RecoveryBundlePayloadKind =
  | "local-snapshot"
  | "shared-history"
  | "executions"
  | "original-actions"
  | "action-archive"
  | "run-archive"
  | "current-assets"
  | "run-assets";
export interface RecoveryBundlePayloadReference {
  readonly kind: RecoveryBundlePayloadKind;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface RecoveryBundleIndex {
  readonly version: typeof RECOVERY_BUNDLE_INDEX_VERSION;
  readonly runAssetCheckpoint: RunArchiveAssetCheckpoint;
  readonly payloads: readonly RecoveryBundlePayloadReference[];
  readonly manifest: AssetManifest;
}
export interface RecoveryBundleCheckpoint {
  readonly version: typeof RECOVERY_BUNDLE_CHECKPOINT_VERSION;
  readonly runAssetCheckpoint: RunArchiveAssetCheckpoint;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface RecoveryBundleSources extends RunArchiveAssetSources {
  readonly runAssets: unknown;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function references(checkpoint: RunArchiveAssetCheckpoint) {
  const runs = checkpoint.binding.checkpoint,
    archive = runs.checkpoint,
    originals = archive.checkpoint,
    executions = originals.checkpoint;
  return Object.freeze(
    (
      [
        ["local-snapshot", checkpoint.binding.localCheckpoint],
        ["shared-history", executions.checkpoint],
        ["executions", executions],
        ["original-actions", originals],
        ["action-archive", archive],
        ["run-archive", runs],
        ["current-assets", checkpoint.assetCheckpoint],
        ["run-assets", checkpoint],
      ] as const
    ).map(([kind, descriptor]) =>
      Object.freeze({
        kind,
        byteLength: descriptor.byteLength,
        sha256: descriptor.sha256,
      }),
    ),
  );
}
function hash(input: unknown) {
  if (typeof input !== "string" || input.length !== 64 || !/^[a-f0-9]{64}$/.test(input))
    throw new SharedRecoveryError("Malformed recovery bundle hash");
  return input;
}
/** Inspect known historical expectations without authorizing source loading or publication. */
export function parseRecoveryBundleCheckpoint(input: unknown): RecoveryBundleCheckpoint {
  const value = fields(input, ["version", "runAssetCheckpoint", "byteLength", "sha256"]);
  if (value.version !== RECOVERY_BUNDLE_CHECKPOINT_VERSION)
    throw new SharedRecoveryError("Unsupported recovery bundle checkpoint version");
  return Object.freeze({
    version: RECOVERY_BUNDLE_CHECKPOINT_VERSION,
    runAssetCheckpoint: parseRunArchiveAssetCheckpoint(value.runAssetCheckpoint),
    byteLength: integer(value.byteLength, 1),
    sha256: hash(value.sha256),
  });
}
/** Structural inventory checks alone do not establish source contents, image bytes or completeness. */
export function parseRecoveryBundleIndex(input: unknown): RecoveryBundleIndex {
  const value = fields(input, ["version", "runAssetCheckpoint", "payloads", "manifest"]);
  if (value.version !== RECOVERY_BUNDLE_INDEX_VERSION)
    throw new SharedRecoveryError("Unsupported recovery bundle index version");
  if (!Array.isArray(value.payloads) || value.payloads.length !== 8)
    throw new SharedRecoveryError("Recovery bundle requires all eight payload references");
  const checkpoint = parseRunArchiveAssetCheckpoint(value.runAssetCheckpoint),
    payloads = array(value.payloads).map((input) => {
      const entry = fields(input, ["kind", "byteLength", "sha256"]);
      return {
        kind: entry.kind,
        byteLength: integer(entry.byteLength, 1),
        sha256: hash(entry.sha256),
      };
    }),
    expected = references(checkpoint);
  if (!same(payloads, expected))
    throw new SharedRecoveryError(
      "Recovery bundle payload inventory differs from original expectations",
    );
  return Object.freeze({
    version: RECOVERY_BUNDLE_INDEX_VERSION,
    runAssetCheckpoint: checkpoint,
    payloads: expected,
    manifest: parseAssetManifest(value.manifest),
  });
}
function sources(input: RecoveryBundleSources) {
  const value = fields(input, [
    "localSnapshot",
    "sharedHistory",
    "executions",
    "originalActions",
    "actionArchive",
    "runArchive",
    "currentAssets",
    "runAssets",
  ]);
  return {
    ...parseRunArchiveAssetSources({
      localSnapshot: value.localSnapshot,
      sharedHistory: value.sharedHistory,
      executions: value.executions,
      originalActions: value.originalActions,
      actionArchive: value.actionArchive,
      runArchive: value.runArchive,
      currentAssets: value.currentAssets,
    }),
    runAssets: parseRunArchiveAssetPayload(value.runAssets),
  };
}
type Sources = ReturnType<typeof sources>;
async function requireSources(
  index: RecoveryBundleIndex,
  source: Sources,
  expected: LocalRecoveryIdentity,
) {
  await requireRunArchiveAssetCheckpoint(
    source.runAssets,
    index.runAssetCheckpoint,
    expected,
    source,
  );
  if (!same(index.manifest, source.runAssets.manifest))
    throw new SharedRecoveryError(
      "Recovery bundle image requirements differ from verified sources",
    );
}
async function describe(index: RecoveryBundleIndex) {
  const bytes = new TextEncoder().encode(JSON.stringify(index)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    index,
    checkpoint: parseRecoveryBundleCheckpoint({
      version: RECOVERY_BUNDLE_CHECKPOINT_VERSION,
      runAssetCheckpoint: index.runAssetCheckpoint,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
/** Own and verify all eight contents before hashing their closed inventory. This publishes no files. */
export async function describeRecoveryBundleIndex(
  checkpoint: unknown,
  contents: RecoveryBundleSources,
) {
  const wanted = parseRunArchiveAssetCheckpoint(checkpoint),
    source = sources(contents),
    identity = parseLocalRecoveryIdentity(wanted.binding.localCheckpoint.identity),
    index = parseRecoveryBundleIndex({
      version: RECOVERY_BUNDLE_INDEX_VERSION,
      runAssetCheckpoint: wanted,
      payloads: references(wanted),
      manifest: source.runAssets.manifest,
    });
  await requireSources(index, source, identity);
  return describe(index);
}
/** Require independent expectations and every source again. Index metadata is not a publication receipt. */
export async function requireRecoveryBundleCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: RecoveryBundleSources,
) {
  const wanted = parseRecoveryBundleCheckpoint(checkpoint),
    index = parseRecoveryBundleIndex(input),
    identity = parseLocalRecoveryIdentity(expected),
    source = sources(contents);
  if (
    !same(wanted.runAssetCheckpoint.binding.localCheckpoint.identity, identity) ||
    !same(index.runAssetCheckpoint.binding.localCheckpoint.identity, identity)
  )
    throw new SharedRecoveryError("Recovery bundle checkpoint identity mismatch");
  if (!same(index.runAssetCheckpoint, wanted.runAssetCheckpoint))
    throw new SharedRecoveryError("Recovery bundle checkpoint binding mismatch");
  const actual = (await describe(index)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Recovery bundle checkpoint content mismatch");
  await requireSources(index, source, identity);
  return index;
}
