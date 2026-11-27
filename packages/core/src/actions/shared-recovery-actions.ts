/** Original action data beside selected executions. This does not define the production log schema. */
import type { ActionInvocation } from "./execution.js";
import type { ActionBindingMap } from "./bindings.js";
import { fields, array, id, integer, bindings, invocation } from "./recovery-action-data.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import { parseSharedRecoveryHistoryPayload } from "./shared-recovery-checkpoint.js";
import {
  parseSharedRecoveryExecutionCheckpoint,
  parseSharedRecoveryExecutionHistory,
  requireSharedRecoveryExecutionCheckpoint,
  type SharedRecoveryExecutionCheckpoint,
  type SharedRecoveryExecutionHistory,
} from "./shared-recovery-executions.js";
import {
  effectAssetNames,
  parseAssetManifest,
  selectAssetManifest,
  type AssetManifest,
} from "./asset-manifest.js";

export const SHARED_RECOVERY_ACTIONS_VERSION = 1;
export const SHARED_RECOVERY_ACTION_CHECKPOINT_VERSION = 1;
export interface SharedRecoveryActionSelection {
  readonly actionIds: readonly string[];
}
export interface SharedRecoveryActionRecord extends ActionInvocation {
  readonly rootId: string;
  readonly parentId: string | null;
  readonly generated: ActionBindingMap;
  /** Canonical positive signed SQLite INTEGER, retained without JavaScript number conversion. */
  readonly seq: string;
  /** Opaque first-record clock metadata. This format does not define a synchronization clock. */
  readonly hlc: string;
  readonly deviceId: string;
  readonly epochId: string;
  readonly schemaId: string;
}
export interface SharedRecoveryActionHistory {
  readonly version: typeof SHARED_RECOVERY_ACTIONS_VERSION;
  readonly checkpoint: SharedRecoveryExecutionCheckpoint;
  readonly selection: SharedRecoveryActionSelection;
  readonly actions: readonly SharedRecoveryActionRecord[];
}
export interface SharedRecoveryActionCheckpoint {
  readonly version: typeof SHARED_RECOVERY_ACTION_CHECKPOINT_VERSION;
  readonly checkpoint: SharedRecoveryExecutionCheckpoint;
  readonly selection: SharedRecoveryActionSelection;
  readonly byteLength: number;
  readonly sha256: string;
}
function selection(
  input: unknown,
  checkpoint: SharedRecoveryExecutionCheckpoint,
): SharedRecoveryActionSelection {
  const value = fields(input, ["actionIds"]);
  const actionIds = array(value.actionIds).map(id);
  if (new Set(actionIds).size !== actionIds.length)
    throw new SharedRecoveryError("Duplicate recovery action selection");
  const ids = new Set(actionIds);
  const roots = checkpoint.selection.effectSets.map(({ rootId }) => rootId);
  if ((!roots.length && actionIds.length) || roots.some((rootId) => !ids.has(rootId)))
    throw new SharedRecoveryError(
      "Original recovery action selection must match the selected roots",
    );
  return Object.freeze({ actionIds: Object.freeze(actionIds) });
}
function sequence(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 19 ||
    !/^[1-9][0-9]*$/.test(input) ||
    BigInt(input).toString() !== input ||
    BigInt(input) > 9223372036854775807n
  )
    throw new SharedRecoveryError(
      "Recovery action sequence requires a positive SQLite INTEGER string",
    );
  return input;
}
function action(input: unknown): SharedRecoveryActionRecord {
  const value = fields(input, [
    "id",
    "rootId",
    "parentId",
    "kind",
    "contractVersion",
    "input",
    "generated",
    "seq",
    "hlc",
    "deviceId",
    "epochId",
    "schemaId",
  ]);
  const original = invocation({
    id: value.id,
    kind: value.kind,
    contractVersion: value.contractVersion,
    input: value.input,
  });
  return Object.freeze({
    id: original.id,
    rootId: id(value.rootId),
    parentId: value.parentId === null ? null : id(value.parentId),
    kind: original.kind,
    contractVersion: original.contractVersion,
    input: original.input,
    generated: bindings(value.generated),
    seq: sequence(value.seq),
    hlc: id(value.hlc),
    deviceId: id(value.deviceId),
    epochId: id(value.epochId),
    schemaId: id(value.schemaId),
  });
}

/** Structural parsing does not establish that records came from trusted first recording. */
export function parseSharedRecoveryActionHistory(input: unknown): SharedRecoveryActionHistory {
  const value = fields(input, ["version", "checkpoint", "selection", "actions"]);
  if (value.version !== SHARED_RECOVERY_ACTIONS_VERSION)
    throw new SharedRecoveryError("Unsupported recovery action history version");
  const checkpoint = parseSharedRecoveryExecutionCheckpoint(value.checkpoint);
  const identity = parseLocalRecoveryIdentity(checkpoint.checkpoint.identity);
  const selected = selection(value.selection, checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_ACTIONS_VERSION,
    checkpoint,
    selection: selected,
    actions: parseRecoveryOriginalActionRecords(
      value.actions,
      selected.actionIds,
      checkpoint.selection.effectSets.map(({ rootId }) => rootId),
      identity,
    ),
  });
}
/** Internal canonical first-record checks shared by current originals and broader archives. Inputs name trusted IDs. */
export function parseRecoveryOriginalActionRecords(
  input: unknown,
  selectedIdsInOrder: readonly string[],
  rootIds: readonly string[],
  identity: LocalRecoveryIdentity,
): readonly SharedRecoveryActionRecord[] {
  const selectedIds = new Set(selectedIdsInOrder),
    byId = new Map<string, SharedRecoveryActionRecord>();
  for (const value of array(input)) {
    const original = action(value);
    if (byId.has(original.id) || !selectedIds.has(original.id))
      throw new SharedRecoveryError("Duplicate or unselected original recovery action");
    byId.set(original.id, original);
  }
  if (byId.size !== selectedIdsInOrder.length)
    throw new SharedRecoveryError("Missing original recovery action");
  const actions = selectedIdsInOrder.map((id) => byId.get(id)!);
  const roots = new Set(rootIds);
  const childIds = new Map<string, ReadonlySet<string>>();
  for (const rootId of roots) {
    const root = byId.get(rootId);
    if (!root || root.rootId !== root.id || root.parentId !== null)
      throw new SharedRecoveryError("Missing or invalid original recovery root");
    childIds.set(
      rootId,
      new Set(
        Object.values(root.generated).flatMap((binding) =>
          binding.type === "child-id" ? [binding.value] : [],
        ),
      ),
    );
  }
  let previous = 0n;
  for (const original of actions) {
    const order = BigInt(original.seq),
      root = byId.get(original.rootId);
    if (order <= previous)
      throw new SharedRecoveryError(
        "Recovery actions must follow unique first-record sequence order",
      );
    previous = order;
    if (!roots.has(original.rootId) || !root || original.contractVersion !== root.contractVersion)
      throw new SharedRecoveryError("Original recovery action root or contract mismatch");
    if (original.epochId !== identity.epochId || original.schemaId !== identity.schemaId)
      throw new SharedRecoveryError("Original recovery action epoch or schema mismatch");
    if (original.id !== original.rootId) {
      const parent = original.parentId === null ? undefined : byId.get(original.parentId);
      if (
        !parent ||
        parent.rootId !== original.rootId ||
        BigInt(parent.seq) >= order ||
        !childIds.get(original.rootId)!.has(original.id)
      )
        throw new SharedRecoveryError(
          "Original recovery child requires an earlier parent and retained child binding",
        );
    } else if (original.parentId !== null)
      throw new SharedRecoveryError("Original recovery root cannot have a parent");
    for (const [path, binding] of Object.entries(original.generated))
      if (JSON.stringify(root.generated[path]) !== JSON.stringify(binding))
        throw new SharedRecoveryError(
          "Original recovery action allocation differs from root bindings",
        );
  }
  return Object.freeze(actions);
}

/** Known historical expectations remain metadata. Actual action payloads require the bundled schema. */
export function parseSharedRecoveryActionCheckpoint(
  input: unknown,
): SharedRecoveryActionCheckpoint {
  const value = fields(input, ["version", "checkpoint", "selection", "byteLength", "sha256"]);
  if (
    value.version !== SHARED_RECOVERY_ACTION_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed recovery action checkpoint");
  const checkpoint = parseSharedRecoveryExecutionCheckpoint(value.checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_ACTION_CHECKPOINT_VERSION,
    checkpoint,
    selection: selection(value.selection, checkpoint),
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
function requireOriginals(
  payload: SharedRecoveryActionHistory,
  executions: SharedRecoveryExecutionHistory,
) {
  if (
    JSON.stringify(executions.checkpoint) !== JSON.stringify(payload.checkpoint.checkpoint) ||
    JSON.stringify(executions.selection) !== JSON.stringify(payload.checkpoint.selection)
  )
    throw new SharedRecoveryError("Original recovery action execution binding mismatch");
  requireRecoveryActionOriginals(payload.actions, executions);
}
/** Internal relation check shared by selected and retained execution preparation. Inputs are already owned. */
export function requireRecoveryActionOriginals(
  actions: readonly SharedRecoveryActionRecord[],
  executions: SharedRecoveryExecutionHistory,
) {
  const originals = new Map(actions.map((original) => [original.id, original]));
  for (const set of executions.effectSets) {
    const root = originals.get(set.invocation.id);
    if (!root || root.rootId !== root.id || root.parentId !== null)
      throw new SharedRecoveryError("Recovery execution has no original root");
    if (
      JSON.stringify(set.invocation) !==
        JSON.stringify(
          invocation({
            id: root.id,
            kind: root.kind,
            contractVersion: root.contractVersion,
            input: root.input,
          }),
        ) ||
      JSON.stringify(set.generated) !== JSON.stringify(root.generated)
    )
      throw new SharedRecoveryError(
        "Recovery execution changes the original root invocation or bindings",
      );
    for (const entry of set.executions) {
      const original = originals.get(entry.id);
      if (
        !original ||
        original.rootId !== root.id ||
        original.parentId !== entry.parentId ||
        original.kind !== entry.kind ||
        original.contractVersion !== entry.contractVersion
      )
        throw new SharedRecoveryError(
          "Recovery execution has no matching original action identity",
        );
    }
  }
}
async function describe(payload: SharedRecoveryActionHistory) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseSharedRecoveryActionCheckpoint({
      version: SHARED_RECOVERY_ACTION_CHECKPOINT_VERSION,
      checkpoint: payload.checkpoint,
      selection: payload.selection,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
export async function describeSharedRecoveryActions(input: {
  actions: unknown;
  checkpoint: unknown;
  selection: SharedRecoveryActionSelection;
  executions: unknown;
  sharedHistory: unknown;
}) {
  const payload = parseSharedRecoveryActionHistory({
    version: SHARED_RECOVERY_ACTIONS_VERSION,
    checkpoint: input.checkpoint,
    selection: input.selection,
    actions: input.actions,
  });
  const executions = parseSharedRecoveryExecutionHistory(input.executions);
  const sharedHistory = parseSharedRecoveryHistoryPayload(input.sharedHistory);
  requireOriginals(payload, executions);
  await requireSharedRecoveryExecutionCheckpoint(
    executions,
    payload.checkpoint,
    payload.checkpoint.checkpoint.identity,
    sharedHistory,
  );
  return describe(payload);
}
export async function requireSharedRecoveryActionCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  executions: unknown,
  sharedHistory: unknown,
) {
  const wanted = parseSharedRecoveryActionCheckpoint(checkpoint);
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryActionHistory(input);
  const sourceExecutions = parseSharedRecoveryExecutionHistory(executions);
  const sourceHistory = parseSharedRecoveryHistoryPayload(sharedHistory);
  if (
    JSON.stringify(payload.checkpoint.checkpoint.identity) !== JSON.stringify(identity) ||
    JSON.stringify(wanted.checkpoint.checkpoint.identity) !== JSON.stringify(identity)
  )
    throw new SharedRecoveryError("Recovery action checkpoint identity mismatch");
  if (
    JSON.stringify(payload.checkpoint) !== JSON.stringify(wanted.checkpoint) ||
    JSON.stringify(payload.selection) !== JSON.stringify(wanted.selection)
  )
    throw new SharedRecoveryError("Recovery action checkpoint binding mismatch");
  requireOriginals(payload, sourceExecutions);
  const actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Recovery action checkpoint content mismatch");
  await requireSharedRecoveryExecutionCheckpoint(
    sourceExecutions,
    wanted.checkpoint,
    identity,
    sourceHistory,
  );
  return payload;
}

/** Original inputs can reference images absent from later selected executions or shared rows. */
export function sharedRecoveryActionAssetManifest(input: unknown, images: unknown): AssetManifest {
  const payload = parseSharedRecoveryActionHistory(input),
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
