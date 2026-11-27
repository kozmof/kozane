/** Retain independent run contexts for every root named by a trusted original-action archive. */
import type { DB } from "../database.js";
import { fields, integer } from "./recovery-action-data.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import { parseSharedRecoveryExecutionHistory } from "./shared-recovery-executions.js";
import { parseSharedRecoveryActionHistory } from "./shared-recovery-actions.js";
import {
  parseSharedRecoveryActionArchive,
  parseSharedRecoveryActionArchiveCheckpoint,
  requireSharedRecoveryActionArchiveCheckpoint,
  type SharedRecoveryActionArchiveCheckpoint,
  type SharedRecoveryActionArchiveSources,
} from "./shared-recovery-action-archive.js";
import {
  parseRecoveryRetainedSelection,
  parseRecoveryRetainedSets,
  requireRecoveryRetainedRelations,
  requireRecoveryRetainedSourceRelations,
  requireRecoveryRetainedContents,
  validateRecoveryRetainedSets,
  recoveryRetainedAssetManifest,
  type SharedRecoveryRetainedSelection,
  type SharedRecoveryRetainedSet,
} from "./shared-recovery-retained-history.js";

export const SHARED_RECOVERY_RUN_ARCHIVE_VERSION = 1;
export const SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION = 1;
export interface SharedRecoveryRunArchive {
  readonly version: typeof SHARED_RECOVERY_RUN_ARCHIVE_VERSION;
  readonly checkpoint: SharedRecoveryActionArchiveCheckpoint;
  readonly selection: SharedRecoveryRetainedSelection;
  readonly effectSets: readonly SharedRecoveryRetainedSet[];
}
export interface SharedRecoveryRunArchiveCheckpoint {
  readonly version: typeof SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION;
  readonly checkpoint: SharedRecoveryActionArchiveCheckpoint;
  readonly selection: SharedRecoveryRetainedSelection;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface SharedRecoveryRunArchiveSources extends SharedRecoveryActionArchiveSources {
  readonly actionArchive: unknown;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** Parse owned inventory and per-run contexts. Authenticity requires a separately retained descriptor. */
export function parseSharedRecoveryRunArchive(input: unknown): SharedRecoveryRunArchive {
  const value = fields(input, ["version", "checkpoint", "selection", "effectSets"]);
  if (value.version !== SHARED_RECOVERY_RUN_ARCHIVE_VERSION)
    throw new SharedRecoveryError("Unsupported recovery run archive version");
  const checkpoint = parseSharedRecoveryActionArchiveCheckpoint(value.checkpoint),
    identity = parseLocalRecoveryIdentity(checkpoint.checkpoint.checkpoint.checkpoint.identity),
    selection = parseRecoveryRetainedSelection(
      value.selection,
      checkpoint.checkpoint.checkpoint,
      checkpoint.selection.rootIds,
    );
  return Object.freeze({
    version: SHARED_RECOVERY_RUN_ARCHIVE_VERSION,
    checkpoint,
    selection,
    effectSets: parseRecoveryRetainedSets(value.effectSets, selection, identity),
  });
}
/** Historical descriptors remain metadata. Actual run contexts require the bundled schema. */
export function parseSharedRecoveryRunArchiveCheckpoint(
  input: unknown,
): SharedRecoveryRunArchiveCheckpoint {
  const value = fields(input, ["version", "checkpoint", "selection", "byteLength", "sha256"]);
  if (
    value.version !== SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed recovery run archive checkpoint");
  const checkpoint = parseSharedRecoveryActionArchiveCheckpoint(value.checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION,
    checkpoint,
    selection: parseRecoveryRetainedSelection(
      value.selection,
      checkpoint.checkpoint.checkpoint,
      checkpoint.selection.rootIds,
    ),
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
function sources(input: SharedRecoveryRunArchiveSources) {
  return {
    actionArchive: parseSharedRecoveryActionArchive(input.actionArchive),
    originals: parseSharedRecoveryActionHistory(input.originals),
    executions: parseSharedRecoveryExecutionHistory(input.executions),
    sharedHistory: parseSharedRecoveryHistoryPayload(input.sharedHistory),
  };
}
function relations(payload: SharedRecoveryRunArchive, source: ReturnType<typeof sources>) {
  if (
    !same(payload.checkpoint.checkpoint, source.actionArchive.checkpoint) ||
    !same(payload.checkpoint.selection, source.actionArchive.selection)
  )
    throw new SharedRecoveryError("Run archive original source binding mismatch");
  requireRecoveryRetainedSourceRelations(
    payload.checkpoint.checkpoint,
    source.originals,
    source.executions,
    source.sharedHistory,
  );
  requireRecoveryRetainedRelations(
    payload.effectSets,
    source.actionArchive.actions,
    source.executions,
    source.sharedHistory,
  );
}
async function requireSources(
  payload: SharedRecoveryRunArchive,
  source: ReturnType<typeof sources>,
) {
  await requireSharedRecoveryActionArchiveCheckpoint(
    source.actionArchive,
    payload.checkpoint,
    payload.checkpoint.checkpoint.checkpoint.checkpoint.identity,
    source,
  );
  await requireRecoveryRetainedContents(payload.effectSets);
}
async function describe(payload: SharedRecoveryRunArchive) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseSharedRecoveryRunArchiveCheckpoint({
      version: SHARED_RECOVERY_RUN_ARCHIVE_CHECKPOINT_VERSION,
      checkpoint: payload.checkpoint,
      selection: payload.selection,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
/** Bind complete trusted run inventory to broader originals and current source contents without selecting extra runs. */
export async function describeSharedRecoveryRunArchive(
  input: SharedRecoveryRunArchiveSources & {
    checkpoint: unknown;
    selection: SharedRecoveryRetainedSelection;
    effectSets: unknown;
  },
) {
  const payload = parseSharedRecoveryRunArchive({
      version: SHARED_RECOVERY_RUN_ARCHIVE_VERSION,
      checkpoint: input.checkpoint,
      selection: input.selection,
      effectSets: input.effectSets,
    }),
    source = sources(input);
  relations(payload, source);
  await requireSources(payload, source);
  return describe(payload);
}
/** Own all sources before hashing and require exact trusted inventory, action identities and selected contexts. */
export async function requireSharedRecoveryRunArchiveCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: SharedRecoveryRunArchiveSources,
) {
  const wanted = parseSharedRecoveryRunArchiveCheckpoint(checkpoint),
    identity = parseLocalRecoveryIdentity(expected),
    payload = parseSharedRecoveryRunArchive(input),
    source = sources(contents);
  if (
    !same(wanted.checkpoint.checkpoint.checkpoint.checkpoint.identity, identity) ||
    !same(payload.checkpoint.checkpoint.checkpoint.checkpoint.identity, identity)
  )
    throw new SharedRecoveryError("Run archive checkpoint identity mismatch");
  if (!same(payload.checkpoint, wanted.checkpoint) || !same(payload.selection, wanted.selection))
    throw new SharedRecoveryError("Run archive checkpoint binding mismatch");
  relations(payload, source);
  const actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Run archive checkpoint content mismatch");
  await requireSources(payload, source);
  return payload;
}
/** Validate each run's complete before and after SQL states in separate empty databases. */
export async function validateSharedRecoveryRunArchive(
  createDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: SharedRecoveryRunArchiveSources,
) {
  const source = sources(contents),
    payload = await requireSharedRecoveryRunArchiveCheckpoint(input, checkpoint, expected, source);
  await validateRecoveryRetainedSets(createDatabase, payload.effectSets, source.sharedHistory);
  return payload;
}
/** Collect each retained run's baseline, full row effects and actual invocation images. */
export function sharedRecoveryRunArchiveAssetManifest(input: unknown, images: unknown) {
  return recoveryRetainedAssetManifest(parseSharedRecoveryRunArchive(input), images);
}
