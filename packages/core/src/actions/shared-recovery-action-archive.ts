/** First-record action archives include roots outside the current materialization without selecting their runs. */
import { fields, array, id, integer } from "./recovery-action-data.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseSharedRecoveryActionCheckpoint,
  parseSharedRecoveryActionHistory,
  parseRecoveryOriginalActionRecords,
  requireSharedRecoveryActionCheckpoint,
  type SharedRecoveryActionCheckpoint,
  type SharedRecoveryActionHistory,
  type SharedRecoveryActionRecord,
} from "./shared-recovery-actions.js";
import { parseSharedRecoveryExecutionHistory } from "./shared-recovery-executions.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import {
  effectAssetNames,
  parseAssetManifest,
  selectAssetManifest,
  type AssetManifest,
} from "./asset-manifest.js";

export const SHARED_RECOVERY_ACTION_ARCHIVE_VERSION = 1;
export const SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION = 1;
export interface SharedRecoveryActionArchiveSelection {
  readonly rootIds: readonly string[];
  readonly actionIds: readonly string[];
}
export interface SharedRecoveryActionArchive {
  readonly version: typeof SHARED_RECOVERY_ACTION_ARCHIVE_VERSION;
  readonly checkpoint: SharedRecoveryActionCheckpoint;
  readonly selection: SharedRecoveryActionArchiveSelection;
  readonly actions: readonly SharedRecoveryActionRecord[];
}
export interface SharedRecoveryActionArchiveCheckpoint {
  readonly version: typeof SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION;
  readonly checkpoint: SharedRecoveryActionCheckpoint;
  readonly selection: SharedRecoveryActionArchiveSelection;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface SharedRecoveryActionArchiveSources {
  readonly originals: unknown;
  readonly executions: unknown;
  readonly sharedHistory: unknown;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function selection(
  input: unknown,
  checkpoint: SharedRecoveryActionCheckpoint,
): SharedRecoveryActionArchiveSelection {
  const value = fields(input, ["rootIds", "actionIds"]),
    rootIds = array(value.rootIds).map(id),
    actionIds = array(value.actionIds).map(id),
    actions = new Map(actionIds.map((id, index) => [id, index])),
    roots = new Set(rootIds);
  if (
    roots.size !== rootIds.length ||
    actions.size !== actionIds.length ||
    rootIds.some((id) => !actions.has(id)) ||
    (!rootIds.length && actionIds.length)
  )
    throw new SharedRecoveryError("Invalid recovery action archive inventory");
  if (
    checkpoint.selection.actionIds.some((id) => !actions.has(id)) ||
    checkpoint.checkpoint.selection.effectSets.some(({ rootId }) => !roots.has(rootId))
  )
    throw new SharedRecoveryError("Action archive inventory omits current originals or roots");
  if (
    rootIds.some(
      (root, index) => index > 0 && actions.get(root)! <= actions.get(rootIds[index - 1])!,
    )
  )
    throw new SharedRecoveryError("Action archive roots must follow first-record selection order");
  return Object.freeze({ rootIds: Object.freeze(rootIds), actionIds: Object.freeze(actionIds) });
}
/** Parse owned canonical records. Only a separately trusted descriptor establishes the archive's contents. */
export function parseSharedRecoveryActionArchive(input: unknown): SharedRecoveryActionArchive {
  const value = fields(input, ["version", "checkpoint", "selection", "actions"]);
  if (value.version !== SHARED_RECOVERY_ACTION_ARCHIVE_VERSION)
    throw new SharedRecoveryError("Unsupported recovery action archive version");
  const checkpoint = parseSharedRecoveryActionCheckpoint(value.checkpoint),
    identity = parseLocalRecoveryIdentity(checkpoint.checkpoint.checkpoint.identity),
    selected = selection(value.selection, checkpoint);
  const actions = parseRecoveryOriginalActionRecords(
    value.actions,
    selected.actionIds,
    selected.rootIds,
    identity,
  );
  return Object.freeze({
    version: SHARED_RECOVERY_ACTION_ARCHIVE_VERSION,
    checkpoint,
    selection: selected,
    actions,
  });
}
/** Known historical source descriptors remain metadata. Archive records require the bundled schema. */
export function parseSharedRecoveryActionArchiveCheckpoint(
  input: unknown,
): SharedRecoveryActionArchiveCheckpoint {
  const value = fields(input, ["version", "checkpoint", "selection", "byteLength", "sha256"]);
  if (
    value.version !== SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed recovery action archive checkpoint");
  const checkpoint = parseSharedRecoveryActionCheckpoint(value.checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION,
    checkpoint,
    selection: selection(value.selection, checkpoint),
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
function sources(input: SharedRecoveryActionArchiveSources) {
  return {
    originals: parseSharedRecoveryActionHistory(input.originals),
    executions: parseSharedRecoveryExecutionHistory(input.executions),
    sharedHistory: parseSharedRecoveryHistoryPayload(input.sharedHistory),
  };
}
function requireOriginals(
  payload: SharedRecoveryActionArchive,
  originals: SharedRecoveryActionHistory,
) {
  if (
    !same(payload.checkpoint.checkpoint, originals.checkpoint) ||
    !same(payload.checkpoint.selection, originals.selection)
  )
    throw new SharedRecoveryError("Action archive original source binding mismatch");
  const archived = new Map(payload.actions.map((action) => [action.id, action]));
  for (const original of originals.actions)
    if (!same(archived.get(original.id), original))
      throw new SharedRecoveryError("Action archive changes a current original record");
}
async function requireSources(
  payload: SharedRecoveryActionArchive,
  source: ReturnType<typeof sources>,
) {
  await requireSharedRecoveryActionCheckpoint(
    source.originals,
    payload.checkpoint,
    payload.checkpoint.checkpoint.checkpoint.identity,
    source.executions,
    source.sharedHistory,
  );
}
async function describe(payload: SharedRecoveryActionArchive) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseSharedRecoveryActionArchiveCheckpoint({
      version: SHARED_RECOVERY_ACTION_ARCHIVE_CHECKPOINT_VERSION,
      checkpoint: payload.checkpoint,
      selection: payload.selection,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
/** Establish expectations from trusted complete first-record inventory, including unselected and skipped actions. */
export async function describeSharedRecoveryActionArchive(
  input: SharedRecoveryActionArchiveSources & {
    checkpoint: unknown;
    selection: SharedRecoveryActionArchiveSelection;
    actions: unknown;
  },
) {
  const payload = parseSharedRecoveryActionArchive({
      version: SHARED_RECOVERY_ACTION_ARCHIVE_VERSION,
      checkpoint: input.checkpoint,
      selection: input.selection,
      actions: input.actions,
    }),
    source = sources(input);
  requireOriginals(payload, source.originals);
  await requireSources(payload, source);
  return describe(payload);
}
/** Own all inputs before hashing, require the exact trusted inventory and preserve the current original records. */
export async function requireSharedRecoveryActionArchiveCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  contents: SharedRecoveryActionArchiveSources,
) {
  const wanted = parseSharedRecoveryActionArchiveCheckpoint(checkpoint),
    identity = parseLocalRecoveryIdentity(expected),
    payload = parseSharedRecoveryActionArchive(input),
    source = sources(contents);
  if (
    !same(wanted.checkpoint.checkpoint.checkpoint.identity, identity) ||
    !same(payload.checkpoint.checkpoint.checkpoint.identity, identity)
  )
    throw new SharedRecoveryError("Action archive checkpoint identity mismatch");
  if (!same(wanted.checkpoint, payload.checkpoint) || !same(wanted.selection, payload.selection))
    throw new SharedRecoveryError("Action archive checkpoint binding mismatch");
  requireOriginals(payload, source.originals);
  const actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Action archive checkpoint content mismatch");
  await requireSources(payload, source);
  return payload;
}
/** Archive inputs include unselected roots and children whose image references may never reach current rows. */
export function sharedRecoveryActionArchiveAssetManifest(
  input: unknown,
  images: unknown,
): AssetManifest {
  const payload = parseSharedRecoveryActionArchive(input),
    manifest = parseAssetManifest(images);
  selectAssetManifest(
    manifest,
    effectAssetNames(
      payload.actions.map(({ input }) => input),
      [],
    ),
  );
  return manifest;
}
