/** Selected execution data and effect attribution, independent of the production log schema. */
import type { ActionInvocation, ActionExecutionRecord } from "./execution.js";
import type { ActionBindingMap, ActionBinding } from "./bindings.js";
import {
  INPUT_MAX_DEPTH,
  INPUT_MAX_NODES,
  INPUT_MAX_STRING_UNITS,
} from "../services/prepare-input.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import { SharedRecoveryError } from "./shared-recovery.js";
import {
  parseSharedRecoveryCheckpoint,
  parseSharedRecoveryHistoryPayload,
  requireSharedRecoveryCheckpoint,
  type SharedRecoveryCheckpoint,
} from "./shared-recovery-checkpoint.js";
import { parseSharedRecoveryHistoryImages } from "./shared-recovery-assets.js";
import {
  effectAssetNames,
  selectAssetManifest,
  mergeAssetManifests,
  type AssetManifest,
} from "./asset-manifest.js";

export const SHARED_RECOVERY_EXECUTIONS_VERSION = 1;
export const SHARED_RECOVERY_EXECUTION_CHECKPOINT_VERSION = 1;
export interface SharedRecoveryExecutionSelection {
  readonly baselineId: string;
  readonly effectSets: readonly {
    readonly id: string;
    readonly rootId: string;
    readonly executionCount: number;
  }[];
}
export interface SharedRecoveryExecutionSet {
  readonly id: string;
  readonly invocation: ActionInvocation;
  readonly generated: ActionBindingMap;
  readonly executions: readonly ActionExecutionRecord[];
  readonly effects: readonly {
    readonly ord: number;
    readonly actionId: string;
    readonly executionOrd: number;
  }[];
}
export interface SharedRecoveryExecutionHistory {
  readonly version: typeof SHARED_RECOVERY_EXECUTIONS_VERSION;
  readonly checkpoint: SharedRecoveryCheckpoint;
  readonly selection: SharedRecoveryExecutionSelection;
  readonly effectSets: readonly SharedRecoveryExecutionSet[];
}
export interface SharedRecoveryExecutionCheckpoint {
  readonly version: typeof SHARED_RECOVERY_EXECUTION_CHECKPOINT_VERSION;
  readonly checkpoint: SharedRecoveryCheckpoint;
  readonly selection: SharedRecoveryExecutionSelection;
  readonly byteLength: number;
  readonly sha256: string;
}
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new SharedRecoveryError("Invalid recovery execution object");
  return Object.fromEntries(
    names.map((name) => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      if (!field || !("value" in field) || !field.enumerable)
        throw new SharedRecoveryError("Recovery execution requires plain data fields");
      return [name, field.value];
    }),
  );
}
function array(input: unknown): unknown[] {
  if (!Array.isArray(input) || Reflect.ownKeys(input).length !== input.length + 1)
    throw new SharedRecoveryError("Invalid recovery execution array");
  return Array.from({ length: input.length }, (_, n) => {
    const field = Object.getOwnPropertyDescriptor(input, String(n));
    if (!field || !("value" in field) || !field.enumerable)
      throw new SharedRecoveryError("Recovery execution requires plain array entries");
    return field.value;
  });
}
function id(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 1000 ||
    input.includes("\0") ||
    !input.isWellFormed()
  )
    throw new SharedRecoveryError("Invalid recovery execution identity");
  return input;
}
function integer(input: unknown, minimum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum)
    throw new SharedRecoveryError("Invalid recovery execution count or ordinal");
  return input as number;
}

/** Strict canonical JSON preserves string values and owns every input without invoking hooks. */
function json(input: unknown): unknown {
  let nodes = 0,
    units = 0;
  const active = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > INPUT_MAX_NODES)
      throw new SharedRecoveryError("Recovery execution JSON exceeds input limits");
    if (typeof value === "string") units += value.length;
    if (units > INPUT_MAX_STRING_UNITS)
      throw new SharedRecoveryError("Recovery execution JSON exceeds input limits");
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value === 0 ? 0 : value;
    if (!value || typeof value !== "object" || depth >= INPUT_MAX_DEPTH || active.has(value))
      throw new SharedRecoveryError("Recovery execution requires finite plain JSON");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > INPUT_MAX_NODES - nodes)
          throw new SharedRecoveryError("Recovery execution JSON exceeds input limits");
        return Object.freeze(array(value).map((child) => copy(child, depth + 1)));
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new SharedRecoveryError("Recovery execution requires finite plain JSON");
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") || keys.length > INPUT_MAX_NODES - nodes)
        throw new SharedRecoveryError("Recovery execution requires finite plain JSON");
      return Object.freeze(
        Object.fromEntries(
          (keys as string[]).sort().map((key) => {
            units += key.length;
            const field = Object.getOwnPropertyDescriptor(value, key)!;
            if (!("value" in field) || !field.enumerable)
              throw new SharedRecoveryError("Recovery execution requires plain JSON fields");
            return [key, copy(field.value, depth + 1)];
          }),
        ),
      );
    } finally {
      active.delete(value);
    }
  }
  return copy(input, 0);
}
function bindings(input: unknown): ActionBindingMap {
  const value = json(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SharedRecoveryError("Invalid recovery execution bindings");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([path, input]) => {
        if (!path) throw new SharedRecoveryError("Invalid recovery execution binding path");
        const binding = fields(input, ["type", "value"]);
        if (binding.type !== "entity-id" && binding.type !== "child-id" && binding.type !== "clock")
          throw new SharedRecoveryError("Invalid recovery execution binding type");
        if (binding.type === "clock") {
          if (!Number.isSafeInteger(binding.value))
            throw new SharedRecoveryError("Invalid recovery execution clock binding");
        } else id(binding.value);
        return [path, Object.freeze({ type: binding.type, value: binding.value }) as ActionBinding];
      }),
    ),
  );
}
function invocation(input: unknown): ActionInvocation {
  const value = fields(input, ["id", "kind", "contractVersion", "input"]);
  return Object.freeze({
    id: id(value.id),
    kind: id(value.kind),
    contractVersion: integer(value.contractVersion, 1),
    input: json(value.input),
  });
}
function selection(
  input: unknown,
  checkpoint: SharedRecoveryCheckpoint,
): SharedRecoveryExecutionSelection {
  const value = fields(input, ["baselineId", "effectSets"]);
  const effectSets = array(value.effectSets).map((input) => {
    const value = fields(input, ["id", "rootId", "executionCount"]);
    return Object.freeze({
      id: id(value.id),
      rootId: id(value.rootId),
      executionCount: integer(value.executionCount, 1),
    });
  });
  const baselineId = id(value.baselineId);
  if (
    baselineId !== checkpoint.selection.baselineId ||
    JSON.stringify(effectSets.map(({ id }) => id)) !==
      JSON.stringify(checkpoint.selection.effectSets.map(({ id }) => id))
  )
    throw new SharedRecoveryError("Recovery execution selection mismatch");
  return Object.freeze({ baselineId, effectSets: Object.freeze(effectSets) });
}
function executionSet(
  input: unknown,
  expected: SharedRecoveryExecutionSelection["effectSets"][number],
  effectCount: number,
): SharedRecoveryExecutionSet {
  const value = fields(input, ["id", "invocation", "generated", "executions", "effects"]);
  const root = invocation(value.invocation),
    generated = bindings(value.generated);
  if (id(value.id) !== expected.id || root.id !== expected.rootId)
    throw new SharedRecoveryError("Recovery execution root mismatch");
  const executions = array(value.executions)
    .map((input) => {
      const value = fields(input, [
        "id",
        "kind",
        "contractVersion",
        "input",
        "parentId",
        "executionOrd",
        "generated",
      ]);
      const action = invocation({
        id: value.id,
        kind: value.kind,
        contractVersion: value.contractVersion,
        input: value.input,
      });
      return Object.freeze({
        ...action,
        parentId: value.parentId === null ? null : id(value.parentId),
        executionOrd: integer(value.executionOrd, 0),
        generated: bindings(value.generated),
      });
    })
    .sort((a, b) => a.executionOrd - b.executionOrd);
  if (executions.length !== expected.executionCount)
    throw new SharedRecoveryError("Recovery execution count mismatch");
  const byId = new Map<string, ActionExecutionRecord>();
  const stack: string[] = [];
  const childBindings = new Map<string, ReadonlySet<string>>();
  for (const [ord, entry] of executions.entries()) {
    if (entry.executionOrd !== ord || byId.has(entry.id))
      throw new SharedRecoveryError(
        "Recovery executions require unique IDs and consecutive ordinals",
      );
    if (entry.contractVersion !== root.contractVersion)
      throw new SharedRecoveryError("Recovery execution contract mismatch");
    if (ord === 0) {
      if (
        entry.parentId !== null ||
        JSON.stringify({
          id: entry.id,
          kind: entry.kind,
          contractVersion: entry.contractVersion,
          input: entry.input,
        }) !== JSON.stringify(root)
      )
        throw new SharedRecoveryError("Recovery execution root record mismatch");
    } else {
      while (stack.length && stack.at(-1) !== entry.parentId) stack.pop();
      if (!stack.length)
        throw new SharedRecoveryError("Recovery execution parent or entry order mismatch");
      if (!childBindings.get(entry.parentId!)!.has(entry.id))
        throw new SharedRecoveryError("Recovery child execution has no parent binding");
    }
    for (const [path, binding] of Object.entries(entry.generated))
      if (JSON.stringify(generated[path]) !== JSON.stringify(binding))
        throw new SharedRecoveryError(
          "Recovery execution allocation differs from retained bindings",
        );
    stack.push(entry.id);
    byId.set(entry.id, entry);
    childBindings.set(
      entry.id,
      new Set(
        Object.values(entry.generated).flatMap((binding) =>
          binding.type === "child-id" ? [binding.value] : [],
        ),
      ),
    );
  }
  const effects = array(value.effects)
    .map((input) => {
      const value = fields(input, ["ord", "actionId", "executionOrd"]);
      return Object.freeze({
        ord: integer(value.ord, 0),
        actionId: id(value.actionId),
        executionOrd: integer(value.executionOrd, 0),
      });
    })
    .sort((a, b) => a.ord - b.ord);
  if (effects.length !== effectCount)
    throw new SharedRecoveryError("Recovery effect attribution count mismatch");
  let entered = -1;
  const active: string[] = [];
  const activeIds = new Set<string>();
  const closed = new Set<string>();
  const closeLast = () => {
    const id = active.pop()!;
    activeIds.delete(id);
    closed.add(id);
  };
  for (const [ord, effect] of effects.entries()) {
    const entry = byId.get(effect.actionId);
    if (effect.ord !== ord || !entry || entry.executionOrd !== effect.executionOrd)
      throw new SharedRecoveryError("Recovery effect attribution mismatch");
    if (entry.executionOrd > entered) {
      const path: string[] = [];
      let ancestor: string | null = entry.id;
      while (ancestor !== null && !activeIds.has(ancestor)) {
        if (closed.has(ancestor))
          throw new SharedRecoveryError("Recovery effects reenter a completed execution");
        path.push(ancestor);
        ancestor = byId.get(ancestor)!.parentId;
      }
      while (active.length && active.at(-1) !== ancestor) closeLast();
      for (const id of path.reverse()) {
        active.push(id);
        activeIds.add(id);
      }
      entered = entry.executionOrd;
    } else {
      if (!activeIds.has(entry.id))
        throw new SharedRecoveryError("Recovery effects reenter a completed execution");
      while (active.at(-1) !== entry.id) closeLast();
    }
  }
  return Object.freeze({
    id: expected.id,
    invocation: root,
    generated,
    executions: Object.freeze(executions),
    effects: Object.freeze(effects),
  });
}

/** Parse selected scope records without invoking handlers or defining the production log schema. */
export function parseSharedRecoveryExecutionHistory(
  input: unknown,
): SharedRecoveryExecutionHistory {
  const value = fields(input, ["version", "checkpoint", "selection", "effectSets"]);
  if (value.version !== SHARED_RECOVERY_EXECUTIONS_VERSION)
    throw new SharedRecoveryError("Unsupported recovery execution history version");
  const checkpoint = parseSharedRecoveryCheckpoint(value.checkpoint);
  parseLocalRecoveryIdentity(checkpoint.identity);
  const selected = selection(value.selection, checkpoint);
  const selectedIds = new Set(selected.effectSets.map(({ id }) => id));
  const sets = new Map<string, unknown>();
  for (const input of array(value.effectSets)) {
    const entry = fields(input, ["id", "invocation", "generated", "executions", "effects"]);
    const key = id(entry.id);
    if (sets.has(key) || !selectedIds.has(key))
      throw new SharedRecoveryError("Duplicate or unselected recovery execution set");
    sets.set(key, input);
  }
  if (sets.size !== selected.effectSets.length)
    throw new SharedRecoveryError("Missing selected recovery execution set");
  const effectSets = selected.effectSets.map((entry, n) =>
    executionSet(sets.get(entry.id), entry, checkpoint.selection.effectSets[n].effectCount),
  );
  const actions = new Map<string, string>();
  for (const set of effectSets)
    for (const entry of set.executions) {
      const identity = JSON.stringify({
        rootId: set.invocation.id,
        parentId: entry.parentId,
        kind: entry.kind,
        contractVersion: entry.contractVersion,
      });
      if (actions.has(entry.id) && actions.get(entry.id) !== identity)
        throw new SharedRecoveryError("Recovery action identity changes between execution sets");
      actions.set(entry.id, identity);
    }
  return Object.freeze({
    version: SHARED_RECOVERY_EXECUTIONS_VERSION,
    checkpoint,
    selection: selected,
    effectSets: Object.freeze(effectSets),
  });
}
/** Historical expectations remain metadata. Actual execution payloads require the bundled schema. */
export function parseSharedRecoveryExecutionCheckpoint(
  input: unknown,
): SharedRecoveryExecutionCheckpoint {
  const value = fields(input, ["version", "checkpoint", "selection", "byteLength", "sha256"]);
  if (
    value.version !== SHARED_RECOVERY_EXECUTION_CHECKPOINT_VERSION ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new SharedRecoveryError("Unsupported or malformed recovery execution checkpoint");
  const checkpoint = parseSharedRecoveryCheckpoint(value.checkpoint);
  return Object.freeze({
    version: SHARED_RECOVERY_EXECUTION_CHECKPOINT_VERSION,
    checkpoint,
    selection: selection(value.selection, checkpoint),
    byteLength: integer(value.byteLength, 1),
    sha256: value.sha256,
  });
}
async function describe(payload: SharedRecoveryExecutionHistory) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    payload,
    checkpoint: parseSharedRecoveryExecutionCheckpoint({
      version: SHARED_RECOVERY_EXECUTION_CHECKPOINT_VERSION,
      checkpoint: payload.checkpoint,
      selection: payload.selection,
      byteLength: bytes.byteLength,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
    }),
  });
}
export async function describeSharedRecoveryExecutions(input: {
  effectSets: unknown;
  checkpoint: unknown;
  selection: SharedRecoveryExecutionSelection;
  sharedHistory: unknown;
}) {
  const payload = parseSharedRecoveryExecutionHistory({
    version: SHARED_RECOVERY_EXECUTIONS_VERSION,
    checkpoint: input.checkpoint,
    selection: input.selection,
    effectSets: input.effectSets,
  });
  const source = parseSharedRecoveryHistoryPayload(input.sharedHistory);
  await requireSharedRecoveryCheckpoint(source, payload.checkpoint, payload.checkpoint.identity);
  return describe(payload);
}
export async function requireSharedRecoveryExecutionCheckpoint(
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  sharedHistory: unknown,
) {
  const wanted = parseSharedRecoveryExecutionCheckpoint(checkpoint);
  const identity = parseLocalRecoveryIdentity(expected);
  const payload = parseSharedRecoveryExecutionHistory(input);
  if (
    JSON.stringify(payload.checkpoint.identity) !== JSON.stringify(identity) ||
    JSON.stringify(wanted.checkpoint.identity) !== JSON.stringify(identity)
  )
    throw new SharedRecoveryError("Recovery execution checkpoint identity mismatch");
  if (
    JSON.stringify(payload.checkpoint) !== JSON.stringify(wanted.checkpoint) ||
    JSON.stringify(payload.selection) !== JSON.stringify(wanted.selection)
  )
    throw new SharedRecoveryError("Recovery execution checkpoint binding mismatch");
  const source = parseSharedRecoveryHistoryPayload(sharedHistory);
  const actual = (await describe(payload)).checkpoint;
  if (actual.byteLength !== wanted.byteLength || actual.sha256 !== wanted.sha256)
    throw new SharedRecoveryError("Recovery execution checkpoint content mismatch");
  await requireSharedRecoveryCheckpoint(source, payload.checkpoint, identity);
  return payload;
}

/** Invocation coverage complements shared row-image coverage. This does not authenticate received records. */
export function sharedRecoveryExecutionAssetManifest(
  input: unknown,
  images: unknown,
): AssetManifest {
  const payload = parseSharedRecoveryExecutionHistory(input);
  const history = parseSharedRecoveryHistoryImages(images);
  if (
    history.baseline.id !== payload.selection.baselineId ||
    JSON.stringify(history.effectSets.map(({ id }) => id)) !==
      JSON.stringify(payload.selection.effectSets.map(({ id }) => id))
  )
    throw new SharedRecoveryError("Recovery execution image selection mismatch");
  for (const [index, set] of payload.effectSets.entries())
    selectAssetManifest(
      history.effectSets[index].manifest,
      effectAssetNames([set.invocation, ...set.executions], []),
    );
  return mergeAssetManifests([
    history.baseline.manifest,
    ...history.effectSets.map(({ manifest }) => manifest),
  ]);
}
