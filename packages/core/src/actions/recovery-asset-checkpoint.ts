/** Content-bound image requirements for an exact pair of recovery payloads. */
import { parseAssetManifest, mergeAssetManifests, type AssetManifest } from "./asset-manifest.js";
import {
  parseLocalRecoveryIdentity,
  parseLocalRecoverySnapshot,
  type LocalRecoveryIdentity,
} from "./local-recovery.js";
import {
  parseLocalRecoveryCheckpoint,
  requireLocalRecoveryCheckpoint,
} from "./local-recovery-checkpoint.js";
import {
  parseSharedRecoveryCheckpoint,
  parseSharedRecoveryHistoryPayload,
  requireSharedRecoveryCheckpoint,
} from "./shared-recovery-checkpoint.js";
import {
  parseSharedRecoveryHistoryImages,
  sharedRecoveryAssetManifest,
  type SharedRecoveryHistoryImages,
} from "./shared-recovery-assets.js";
import { localRecoveryAssetManifest } from "./local-recovery-assets.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import type { SharedRecoveryCheckpointBinding } from "./shared-recovery-store.js";

export const RECOVERY_ASSET_PAYLOAD_VERSION = 1;
export const RECOVERY_ASSET_CHECKPOINT_VERSION = 1;
export interface RecoveryAssetPayload {
  readonly version: typeof RECOVERY_ASSET_PAYLOAD_VERSION;
  readonly binding: SharedRecoveryCheckpointBinding;
  readonly history: SharedRecoveryHistoryImages;
  readonly manifest: AssetManifest;
}
export interface RecoveryAssetCheckpoint {
  readonly version: typeof RECOVERY_ASSET_CHECKPOINT_VERSION;
  readonly binding: SharedRecoveryCheckpointBinding;
  readonly byteLength: number;
  readonly sha256: string;
}
type Sources = Readonly<{ localSnapshot: unknown; sharedHistory: unknown }>;
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new SharedRecoveryError("Invalid recovery asset checkpoint data");
  return Object.fromEntries(
    names.map((name) => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      if (!field || !("value" in field) || !field.enumerable)
        throw new SharedRecoveryError("Recovery asset checkpoint requires plain fields");
      return [name, field.value];
    }),
  );
}
function parseBinding(input: unknown): SharedRecoveryCheckpointBinding {
  const value = fields(input, ["checkpoint", "localCheckpoint"]);
  const checkpoint = parseSharedRecoveryCheckpoint(value.checkpoint);
  const localCheckpoint = parseLocalRecoveryCheckpoint(value.localCheckpoint);
  if (
    JSON.stringify(checkpoint.identity) !== JSON.stringify(localCheckpoint.identity) ||
    checkpoint.selection.baselineId !== localCheckpoint.selection.baselineId ||
    JSON.stringify(checkpoint.selection.effectSets.map(({ id }) => id)) !==
      JSON.stringify(localCheckpoint.selection.effectSetIds)
  )
    throw new SharedRecoveryError("Recovery asset checkpoint binding mismatch");
  return Object.freeze({ checkpoint, localCheckpoint });
}
function requireSelection(
  binding: SharedRecoveryCheckpointBinding,
  history: SharedRecoveryHistoryImages,
) {
  if (
    history.baseline.id !== binding.checkpoint.selection.baselineId ||
    JSON.stringify(history.effectSets.map(({ id }) => id)) !==
      JSON.stringify(binding.checkpoint.selection.effectSets.map(({ id }) => id))
  )
    throw new SharedRecoveryError("Recovery asset checkpoint selection mismatch");
}

/** Historical descriptors remain readable as metadata. Payload preparation requires the current schema. */
export function parseRecoveryAssetCheckpoint(input: unknown): RecoveryAssetCheckpoint {
  const value = fields(input, ["version", "binding", "byteLength", "sha256"]);
  if (
    value.version !== RECOVERY_ASSET_CHECKPOINT_VERSION ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.sha256.length !== 64
  )
    throw new SharedRecoveryError("Unsupported or malformed recovery asset checkpoint");
  return Object.freeze({
    version: RECOVERY_ASSET_CHECKPOINT_VERSION,
    binding: parseBinding(value.binding),
    byteLength: value.byteLength as number,
    sha256: value.sha256,
  });
}

/** Parsing owns canonical metadata. Sources are needed separately to verify its actual coverage. */
export function parseRecoveryAssetPayload(input: unknown): RecoveryAssetPayload {
  const value = fields(input, ["version", "binding", "history", "manifest"]);
  if (value.version !== RECOVERY_ASSET_PAYLOAD_VERSION)
    throw new SharedRecoveryError("Unsupported recovery asset payload version");
  const binding = parseBinding(value.binding);
  parseLocalRecoveryIdentity(binding.checkpoint.identity);
  const history = parseSharedRecoveryHistoryImages(value.history);
  requireSelection(binding, history);
  const manifest = parseAssetManifest(value.manifest);
  const union = mergeAssetManifests([
    manifest,
    history.baseline.manifest,
    ...history.effectSets.map(({ manifest }) => manifest),
  ]);
  if (JSON.stringify(union) !== JSON.stringify(manifest))
    throw new SharedRecoveryError("Recovery asset payload omits history requirements");
  return Object.freeze({ version: RECOVERY_ASSET_PAYLOAD_VERSION, binding, history, manifest });
}
function sources(input: Sources) {
  return {
    localSnapshot: parseLocalRecoverySnapshot(input.localSnapshot),
    sharedHistory: parseSharedRecoveryHistoryPayload(input.sharedHistory),
  };
}
type PreparedSources = ReturnType<typeof sources>;
function collect(source: PreparedSources, history: SharedRecoveryHistoryImages) {
  return localRecoveryAssetManifest(source.localSnapshot, [
    sharedRecoveryAssetManifest(source.sharedHistory, history),
  ]);
}
async function requireSources(source: PreparedSources, binding: SharedRecoveryCheckpointBinding) {
  await requireLocalRecoveryCheckpoint(source.localSnapshot, binding.localCheckpoint);
  await requireSharedRecoveryCheckpoint(
    source.sharedHistory,
    binding.checkpoint,
    binding.checkpoint.identity,
  );
}
async function describe(payload: RecoveryAssetPayload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseRecoveryAssetCheckpoint({
      version: RECOVERY_ASSET_CHECKPOINT_VERSION,
      binding: payload.binding,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    }),
  });
}

/** Establish expectations only from trusted complete host manifests and the original checkpoint pair. */
export async function describeRecoveryAssets(
  input: Sources & { binding: unknown; history: unknown },
) {
  const binding = parseBinding(input.binding);
  const history = parseSharedRecoveryHistoryImages(input.history);
  const source = sources(input);
  requireSelection(binding, history);
  const payload = parseRecoveryAssetPayload({
    version: RECOVERY_ASSET_PAYLOAD_VERSION,
    binding,
    history,
    manifest: collect(source, history),
  });
  await requireSources(source, binding);
  return describe(payload);
}

/** Copy all inputs before hashing and verify against a separately retained asset expectation. No SQL or file installation. */
export async function requireRecoveryAssetCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: Sources,
) {
  const wanted = parseRecoveryAssetCheckpoint(checkpoint);
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseRecoveryAssetPayload(input);
  if (
    JSON.stringify(payload.binding.checkpoint.identity) !== JSON.stringify(identity) ||
    JSON.stringify(wanted.binding.checkpoint.identity) !== JSON.stringify(identity)
  )
    throw new SharedRecoveryError("Recovery asset checkpoint identity mismatch");
  if (JSON.stringify(payload.binding) !== JSON.stringify(wanted.binding))
    throw new SharedRecoveryError("Recovery asset checkpoint binding mismatch");
  const source = sources(contents);
  const actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Recovery asset checkpoint content mismatch");
  await requireSources(source, payload.binding);
  if (JSON.stringify(collect(source, payload.history)) !== JSON.stringify(payload.manifest))
    throw new SharedRecoveryError("Recovery asset payload requirements mismatch");
  return payload;
}
