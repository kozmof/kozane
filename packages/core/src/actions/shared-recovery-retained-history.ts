/** Retained origin, rebase and authoritative runs, independent of the production log schema. */
import type { DB } from "../database.js";
import { fields, array, id, integer } from "./recovery-action-data.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  SharedRecoveryError,
  reconstructSharedRecoveryProjection,
  validateSharedRecoveryProjection,
} from "./shared-recovery.js";
import {
  parseSharedRecoveryHistoryPayload,
  requireSharedRecoveryCheckpoint,
  type SharedRecoveryHistoryPayload,
} from "./shared-recovery-checkpoint.js";
import {
  parseSharedRecoveryExecutionHistory,
  sharedRecoveryExecutionAssetManifest,
  type SharedRecoveryExecutionHistory,
  type SharedRecoveryExecutionCheckpoint,
} from "./shared-recovery-executions.js";
import {
  parseSharedRecoveryActionCheckpoint,
  parseSharedRecoveryActionHistory,
  requireSharedRecoveryActionCheckpoint,
  requireRecoveryActionOriginals,
  type SharedRecoveryActionCheckpoint,
  type SharedRecoveryActionHistory,
  type SharedRecoveryActionRecord,
} from "./shared-recovery-actions.js";
import {
  parseSharedRecoveryHistoryImages,
  sharedRecoveryAssetManifest,
  type SharedRecoveryHistoryImages,
} from "./shared-recovery-assets.js";
import { mergeAssetManifests, type AssetManifest } from "./asset-manifest.js";

export const SHARED_RECOVERY_RETAINED_HISTORY_VERSION = 1;
export const SHARED_RECOVERY_RETAINED_CHECKPOINT_VERSION = 1;
export type SharedRecoveryEffectSetSource = "origin" | "rebase" | "authoritative";
export interface SharedRecoveryRetainedSelection {
  readonly effectSets: readonly {
    readonly id: string;
    readonly rootId: string;
    readonly source: SharedRecoveryEffectSetSource;
    readonly baselineId: string;
    readonly effectCount: number;
    readonly executionCount: number;
  }[];
}
export interface SharedRecoveryRetainedSet {
  readonly id: string;
  readonly rootId: string;
  readonly source: SharedRecoveryEffectSetSource;
  readonly history: SharedRecoveryHistoryPayload;
  readonly executions: SharedRecoveryExecutionHistory;
}
export interface SharedRecoveryRetainedHistory {
  readonly version: typeof SHARED_RECOVERY_RETAINED_HISTORY_VERSION;
  readonly checkpoint: SharedRecoveryActionCheckpoint;
  readonly selection: SharedRecoveryRetainedSelection;
  readonly effectSets: readonly SharedRecoveryRetainedSet[];
}
export interface SharedRecoveryRetainedCheckpoint {
  readonly version: typeof SHARED_RECOVERY_RETAINED_CHECKPOINT_VERSION;
  readonly checkpoint: SharedRecoveryActionCheckpoint;
  readonly selection: SharedRecoveryRetainedSelection;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface SharedRecoveryRetainedImages {
  readonly effectSets: readonly {
    readonly id: string;
    readonly history: SharedRecoveryHistoryImages;
  }[];
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function source(input: unknown): SharedRecoveryEffectSetSource {
  if (input !== "origin" && input !== "rebase" && input !== "authoritative")
    throw new SharedRecoveryError("Invalid retained recovery effect-set source");
  return input;
}
export function parseRecoveryRetainedSelection(
  input: unknown,
  checkpoint: SharedRecoveryExecutionCheckpoint,
  rootIds: readonly string[] = checkpoint.selection.effectSets.map(({ rootId }) => rootId),
): SharedRecoveryRetainedSelection {
  const value = fields(input, ["effectSets"]);
  const roots = new Set(rootIds);
  const seen = new Map<string, SharedRecoveryRetainedSelection["effectSets"][number]>();
  const effectSets = array(value.effectSets).map((input) => {
    const value = fields(input, [
      "id",
      "rootId",
      "source",
      "baselineId",
      "effectCount",
      "executionCount",
    ]);
    const entry = Object.freeze({
      id: id(value.id),
      rootId: id(value.rootId),
      source: source(value.source),
      baselineId: id(value.baselineId),
      effectCount: integer(value.effectCount, 0),
      executionCount: integer(value.executionCount, 1),
    });
    if (seen.has(entry.id) || !roots.has(entry.rootId))
      throw new SharedRecoveryError("Duplicate retained set or root outside original checkpoint");
    seen.set(entry.id, entry);
    return entry;
  });
  for (const [index, current] of checkpoint.selection.effectSets.entries()) {
    const retained = seen.get(current.id);
    if (
      !retained ||
      retained.rootId !== current.rootId ||
      retained.executionCount !== current.executionCount ||
      retained.effectCount !== checkpoint.checkpoint.selection.effectSets[index].effectCount
    )
      throw new SharedRecoveryError(
        "Retained inventory does not cover the selected execution history",
      );
  }
  return Object.freeze({ effectSets: Object.freeze(effectSets) });
}
function retainedSet(
  input: unknown,
  expected: SharedRecoveryRetainedSelection["effectSets"][number],
  identity: LocalRecoveryIdentity,
): SharedRecoveryRetainedSet {
  const value = fields(input, ["id", "rootId", "source", "history", "executions"]);
  if (
    id(value.id) !== expected.id ||
    id(value.rootId) !== expected.rootId ||
    source(value.source) !== expected.source
  )
    throw new SharedRecoveryError("Retained recovery provenance mismatch");
  const history = parseSharedRecoveryHistoryPayload(value.history),
    executions = parseSharedRecoveryExecutionHistory(value.executions);
  if (!same(history.identity, identity) || !same(executions.checkpoint.identity, identity))
    throw new SharedRecoveryError("Retained recovery checkpoint identity mismatch");
  if (
    !same(history.selection, {
      baselineId: expected.baselineId,
      effectSets: [{ id: expected.id, effectCount: expected.effectCount }],
    }) ||
    !same(executions.checkpoint.selection, history.selection) ||
    !same(executions.selection, {
      baselineId: expected.baselineId,
      effectSets: [
        { id: expected.id, rootId: expected.rootId, executionCount: expected.executionCount },
      ],
    })
  )
    throw new SharedRecoveryError(
      "Retained recovery context, count or execution selection mismatch",
    );
  return Object.freeze({
    id: expected.id,
    rootId: expected.rootId,
    source: expected.source,
    history,
    executions,
  });
}
/** Canonical retained inventory and per-run reconstruction. Parsing alone does not establish authenticity. */
export function parseSharedRecoveryRetainedHistory(input: unknown): SharedRecoveryRetainedHistory {
  const value = fields(input, ["version", "checkpoint", "selection", "effectSets"]);
  if (value.version !== SHARED_RECOVERY_RETAINED_HISTORY_VERSION)
    throw new SharedRecoveryError("Unsupported retained recovery history version");
  const checkpoint = parseSharedRecoveryActionCheckpoint(value.checkpoint);
  const identity = parseLocalRecoveryIdentity(checkpoint.checkpoint.checkpoint.identity);
  const selected = parseRecoveryRetainedSelection(value.selection, checkpoint.checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_RETAINED_HISTORY_VERSION,
    checkpoint,
    selection: selected,
    effectSets: parseRecoveryRetainedSets(value.effectSets, selected, identity),
  });
}
/** Internal owned per-run parser shared with broader archives. */
export function parseRecoveryRetainedSets(
  input: unknown,
  selected: SharedRecoveryRetainedSelection,
  identity: LocalRecoveryIdentity,
) {
  const expected = new Map(selected.effectSets.map((entry) => [entry.id, entry]));
  const sets = new Map<string, SharedRecoveryRetainedSet>();
  for (const entry of array(input)) {
    const value = fields(entry, ["id", "rootId", "source", "history", "executions"]),
      key = id(value.id),
      wanted = expected.get(key);
    if (!wanted || sets.has(key))
      throw new SharedRecoveryError("Unselected or duplicate retained recovery set");
    sets.set(key, retainedSet(entry, wanted, identity));
  }
  if (sets.size !== selected.effectSets.length)
    throw new SharedRecoveryError("Missing retained recovery set");
  return Object.freeze(selected.effectSets.map(({ id }) => sets.get(id)!));
}
/** Historical expectations remain inspectable metadata. Actual retained contexts require the bundled schema. */
export function parseSharedRecoveryRetainedCheckpoint(
  input: unknown,
): SharedRecoveryRetainedCheckpoint {
  const value = fields(input, ["version", "checkpoint", "selection", "byteLength", "sha256"]);
  if (
    value.version !== SHARED_RECOVERY_RETAINED_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed retained recovery checkpoint");
  const checkpoint = parseSharedRecoveryActionCheckpoint(value.checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_RETAINED_CHECKPOINT_VERSION,
    checkpoint,
    selection: parseRecoveryRetainedSelection(value.selection, checkpoint.checkpoint),
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
function after(set: SharedRecoveryRetainedSet) {
  return reconstructSharedRecoveryProjection(set.history.history, set.history.selection);
}
function relations(
  payload: SharedRecoveryRetainedHistory,
  originals: SharedRecoveryActionHistory,
  executions: SharedRecoveryExecutionHistory,
  history: SharedRecoveryHistoryPayload,
) {
  requireRecoveryRetainedSourceRelations(payload.checkpoint, originals, executions, history);
  requireRecoveryRetainedRelations(payload.effectSets, originals.actions, executions, history);
}
/** Internal current-source binding check shared with broader archives. */
export function requireRecoveryRetainedSourceRelations(
  checkpoint: SharedRecoveryActionCheckpoint,
  originals: SharedRecoveryActionHistory,
  executions: SharedRecoveryExecutionHistory,
  history: SharedRecoveryHistoryPayload,
) {
  if (
    !same(originals.checkpoint, checkpoint.checkpoint) ||
    !same(originals.selection, checkpoint.selection) ||
    !same(executions.checkpoint, checkpoint.checkpoint.checkpoint) ||
    !same(executions.selection, checkpoint.checkpoint.selection) ||
    !same(history.identity, checkpoint.checkpoint.checkpoint.identity) ||
    !same(history.selection, checkpoint.checkpoint.checkpoint.selection)
  )
    throw new SharedRecoveryError("Retained recovery original source binding mismatch");
}
/** Internal relation checks use complete originals supplied by either retained format. */
export function requireRecoveryRetainedRelations(
  effectSets: readonly SharedRecoveryRetainedSet[],
  actions: readonly SharedRecoveryActionRecord[],
  executions: SharedRecoveryExecutionHistory,
  history: SharedRecoveryHistoryPayload,
) {
  for (const set of effectSets) requireRecoveryActionOriginals(actions, set.executions);
  const retained = new Map(effectSets.map((set) => [set.id, set]));
  let before = history.history.baseline.projection;
  for (const [index, selected] of history.history.effectSets.entries()) {
    const set = retained.get(selected.id)!;
    if (
      !same(set.history.history.effectSets[0], selected) ||
      !same(set.executions.effectSets[0], executions.effectSets[index]) ||
      !same(set.history.history.baseline.projection, before)
    )
      throw new SharedRecoveryError(
        "Selected retained context or contents differ from materialized history",
      );
    // Advance once per selected set. Never apply deselected runs or repeatedly replay a growing prefix.
    before = after(set);
  }
}
async function requireContents(
  payload: SharedRecoveryRetainedHistory,
  originals: SharedRecoveryActionHistory,
  executions: SharedRecoveryExecutionHistory,
  history: SharedRecoveryHistoryPayload,
) {
  await requireSharedRecoveryActionCheckpoint(
    originals,
    payload.checkpoint,
    payload.checkpoint.checkpoint.checkpoint.identity,
    executions,
    history,
  );
  await requireRecoveryRetainedContents(payload.effectSets);
}
/** Internal per-run hash checks after all caller-owned inputs are copied. */
export async function requireRecoveryRetainedContents(
  effectSets: readonly SharedRecoveryRetainedSet[],
) {
  for (const set of effectSets)
    await requireSharedRecoveryCheckpoint(
      set.history,
      set.executions.checkpoint,
      set.history.identity,
    );
}
async function describe(payload: SharedRecoveryRetainedHistory) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseSharedRecoveryRetainedCheckpoint({
      version: SHARED_RECOVERY_RETAINED_CHECKPOINT_VERSION,
      checkpoint: payload.checkpoint,
      selection: payload.selection,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
export async function describeSharedRecoveryRetainedHistory(input: {
  checkpoint: unknown;
  selection: SharedRecoveryRetainedSelection;
  effectSets: unknown;
  originals: unknown;
  executions: unknown;
  sharedHistory: unknown;
}) {
  const payload = parseSharedRecoveryRetainedHistory({
    version: SHARED_RECOVERY_RETAINED_HISTORY_VERSION,
    checkpoint: input.checkpoint,
    selection: input.selection,
    effectSets: input.effectSets,
  });
  const originals = parseSharedRecoveryActionHistory(input.originals),
    executions = parseSharedRecoveryExecutionHistory(input.executions),
    history = parseSharedRecoveryHistoryPayload(input.sharedHistory);
  relations(payload, originals, executions, history);
  await requireContents(payload, originals, executions, history);
  return describe(payload);
}
export async function requireSharedRecoveryRetainedCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  originals: unknown,
  executions: unknown,
  sharedHistory: unknown,
) {
  const wanted = parseSharedRecoveryRetainedCheckpoint(checkpoint),
    identity = parseLocalRecoveryIdentity(expected),
    payload = parseSharedRecoveryRetainedHistory(input);
  const originalData = parseSharedRecoveryActionHistory(originals),
    executionData = parseSharedRecoveryExecutionHistory(executions),
    history = parseSharedRecoveryHistoryPayload(sharedHistory);
  if (
    !same(wanted.checkpoint.checkpoint.checkpoint.identity, identity) ||
    !same(payload.checkpoint.checkpoint.checkpoint.identity, identity)
  )
    throw new SharedRecoveryError("Retained recovery checkpoint identity mismatch");
  if (!same(payload.checkpoint, wanted.checkpoint) || !same(payload.selection, wanted.selection))
    throw new SharedRecoveryError("Retained recovery checkpoint binding mismatch");
  relations(payload, originalData, executionData, history);
  const actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Retained recovery checkpoint content mismatch");
  await requireContents(payload, originalData, executionData, history);
  return payload;
}
/** Validate both committed endpoints of every run in separate empty databases, never in the live source. */
export async function validateSharedRecoveryRetainedHistory(
  createDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  originals: unknown,
  executions: unknown,
  sharedHistory: unknown,
) {
  const history = parseSharedRecoveryHistoryPayload(sharedHistory);
  const payload = await requireSharedRecoveryRetainedCheckpoint(
    input,
    checkpoint,
    expected,
    originals,
    executions,
    history,
  );
  await validateRecoveryRetainedSets(createDatabase, payload.effectSets, history);
  return payload;
}
/** Internal endpoint validation shared by selected-root and broader run archives. */
export async function validateRecoveryRetainedSets(
  createDatabase: () => Promise<DB>,
  effectSets: readonly SharedRecoveryRetainedSet[],
  history: SharedRecoveryHistoryPayload,
) {
  if (!effectSets.length || !history.history.effectSets.length)
    await validateSharedRecoveryProjection(createDatabase, history.history.baseline.projection);
  for (const set of effectSets) {
    await validateSharedRecoveryProjection(createDatabase, set.history.history.baseline.projection);
    await validateSharedRecoveryProjection(createDatabase, after(set));
  }
}
/** Own per-run image metadata without invoking transport hooks. Selection and coverage need the retained history. */
export function parseSharedRecoveryRetainedImages(input: unknown): SharedRecoveryRetainedImages {
  const value = fields(input, ["effectSets"]);
  const entries = array(value.effectSets).map((input) => {
    const value = fields(input, ["id", "history"]);
    return Object.freeze({
      id: id(value.id),
      history: parseSharedRecoveryHistoryImages(value.history),
    });
  });
  return Object.freeze({ effectSets: Object.freeze(entries) });
}
/** Per-run baseline, row and actual invocation coverage, including deselected children and intermediate images. */
export function sharedRecoveryRetainedAssetManifest(
  input: unknown,
  images: unknown,
): AssetManifest {
  return recoveryRetainedAssetManifest(parseSharedRecoveryRetainedHistory(input), images);
}
/** Internal collector checks already parsed run inventories and owns supplied image metadata. */
export function recoveryRetainedAssetManifest(
  payload: Pick<SharedRecoveryRetainedHistory, "selection" | "effectSets">,
  images: unknown,
) {
  const entries = parseSharedRecoveryRetainedImages(images).effectSets;
  if (
    !same(
      entries.map(({ id }) => id),
      payload.selection.effectSets.map(({ id }) => id),
    )
  )
    throw new SharedRecoveryError("Retained recovery image selection mismatch");
  return mergeAssetManifests(
    payload.effectSets.flatMap((set, index) => [
      sharedRecoveryAssetManifest(set.history, entries[index].history),
      sharedRecoveryExecutionAssetManifest(set.executions, entries[index].history),
    ]),
  );
}
