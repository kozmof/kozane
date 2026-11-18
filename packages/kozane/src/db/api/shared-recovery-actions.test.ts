import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrations } from "@kozane/core/migrations";
import {
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  parseSharedRecoveryActionHistory,
  parseSharedRecoveryActionCheckpoint,
  describeSharedRecoveryActions,
  requireSharedRecoveryActionCheckpoint,
  sharedRecoveryActionAssetManifest,
  type SharedRecoveryActionRecord,
} from "@kozane/core/recovery";
import type { DB } from "../../../../core/src/database.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { createTestDB } from "../../test-utils/db.js";
import { capturedTables } from "../../test-utils/action-capture.js";

const identity = {
  workspaceId: "workspace",
  deviceId: "checkpoint-device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const reference = (n: number) => `kozane-image:/api/images/${filename(n)}`;
const manifest = (...ns: number[]) => ({
  version: 1 as const,
  entries: ns.map((n) => ({
    name: `.kozane/assets/images/${filename(n)}`,
    byteLength: 3,
    sha256: "a".repeat(64),
  })),
});
const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
const emptyProjection = () => ({
  version: 1,
  rowEncodingVersion: 1,
  schemaId: identity.schemaId,
  tables: capturedTables.map(({ name }) => ({ name, rows: [] })),
});
const provenance = (seq: string) => ({
  seq,
  hlc: "opaque:first-record",
  deviceId: "recording-device",
  epochId: identity.epochId,
  schemaId: identity.schemaId,
});
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const source = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: emptyProjection() },
      effectSets: [
        { id: "rebase", effects: [] },
        { id: "authoritative", effects: [] },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "rebase", effectCount: 0 },
        { id: "authoritative", effectCount: 0 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  const invocation = {
    id: "root",
    kind: "future.root",
    contractVersion: 99,
    input: { z: reference(0), a: '\ufeff{"exact":true}\0🪁', zero: -0 },
  };
  const empty = {
    id: "empty-root",
    kind: "future.empty",
    contractVersion: 99,
    input: { ref: reference(4) },
  };
  const generated = {
    child: { type: "child-id" as const, value: "child" },
    skipped: { type: "child-id" as const, value: "skipped" },
    noop: { type: "child-id" as const, value: "noop" },
    clock: { type: "clock" as const, value: -123 },
    unused: { type: "entity-id" as const, value: "unused" },
  };
  const rootRecord = {
    ...invocation,
    parentId: null,
    executionOrd: 0,
    generated: { child: generated.child, noop: generated.noop },
  };
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: source.checkpoint,
    sharedHistory: source.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [
        { id: "rebase", rootId: "root", executionCount: 3 },
        { id: "authoritative", rootId: "root", executionCount: 1 },
        { id: "empty", rootId: "empty-root", executionCount: 1 },
      ],
    },
    effectSets: [
      {
        id: "rebase",
        invocation,
        generated,
        executions: [
          rootRecord,
          {
            id: "child",
            kind: "future.child",
            contractVersion: 99,
            input: { ref: reference(2) },
            parentId: "root",
            executionOrd: 1,
            generated: {},
          },
          {
            id: "noop",
            kind: "future.noop",
            contractVersion: 99,
            input: { ref: reference(3) },
            parentId: "root",
            executionOrd: 2,
            generated: {},
          },
        ],
        effects: [],
      },
      {
        id: "authoritative",
        invocation,
        generated,
        executions: [{ ...rootRecord, generated: {} }],
        effects: [],
      },
      {
        id: "empty",
        invocation: empty,
        generated: {},
        executions: [{ ...empty, parentId: null, executionOrd: 0, generated: {} }],
        effects: [],
      },
    ],
  });
  const actions: SharedRecoveryActionRecord[] = [
    { ...invocation, rootId: "root", parentId: null, generated, ...provenance("1") },
    {
      id: "child",
      rootId: "root",
      parentId: "root",
      kind: "future.child",
      contractVersion: 99,
      input: { ref: reference(1) },
      generated: { clock: generated.clock },
      ...provenance("2"),
    },
    {
      id: "skipped",
      rootId: "root",
      parentId: "root",
      kind: "future.skipped",
      contractVersion: 99,
      input: { ref: reference(5) },
      generated: {},
      ...provenance("3"),
    },
    {
      id: "noop",
      rootId: "root",
      parentId: "root",
      kind: "future.noop",
      contractVersion: 99,
      input: { ref: reference(3) },
      generated: {},
      ...provenance("4"),
    },
    {
      ...empty,
      rootId: "empty-root",
      parentId: null,
      generated: {},
      ...provenance("9007199254740993"),
    },
  ];
  const selection = { actionIds: ["root", "child", "skipped", "noop", "empty-root"] };
  return {
    source,
    executions,
    actions,
    selection,
    options: () => ({
      checkpoint: executions.checkpoint,
      executions: executions.payload,
      sharedHistory: source.payload,
      actions,
      selection,
    }),
  };
}
it("binds original records, exact first-record metadata and unused bindings beside changed and skipped executions", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options());
  expect(result.payload.actions.map(({ id }) => id)).toEqual(f.selection.actionIds);
  expect(result.payload.actions[1].input).toEqual({ ref: reference(1) });
  expect(f.executions.payload.effectSets[0].executions[1].input).toEqual({ ref: reference(2) });
  expect(result.payload.actions[2].id).toBe("skipped");
  expect(result.payload.actions[4].seq).toBe("9007199254740993");
  expect(result.payload.actions[0].deviceId).not.toBe(identity.deviceId);
  expect(result.payload.actions[0].input).toEqual({
    a: '\ufeff{"exact":true}\0🪁',
    z: reference(0),
    zero: 0,
  });
  expect(result.payload.actions[0].generated.unused.value).toBe("unused");
  expect(Object.isFrozen(result.payload.actions[0].input)).toBe(true);
  expect(Object.isFrozen(result.payload.actions[0].generated)).toBe(true);
  expect(Object.isFrozen(result.checkpoint.selection.actionIds)).toBe(true);
  expect(result.checkpoint.byteLength).toBe(
    new TextEncoder().encode(JSON.stringify(result.payload)).byteLength,
  );
  expect(
    await requireSharedRecoveryActionCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      f.executions.payload,
      f.source.payload,
    ),
  ).toEqual(result.payload);
  const reversed = clone(f.options());
  reversed.actions.reverse();
  expect((await describeSharedRecoveryActions(reversed)).checkpoint).toEqual(result.checkpoint);
  expect(parseSharedRecoveryActionCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
});

it.each([
  "duplicate",
  "unselected",
  "missing",
  "selection-duplicate",
  "selection-order",
  "sequence-duplicate",
  "parent-missing",
  "parent-later",
  "parent-cross-root",
  "root-parent",
  "root-missing",
  "unselected-root",
  "contract",
  "epoch",
  "schema",
  "unbound-child",
  "allocation",
])("refuses malformed original action %s", async (change) => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options()),
    payload = clone(result.payload);
  if (change === "duplicate") payload.actions.push(payload.actions[1]);
  if (change === "unselected") payload.actions.push({ ...payload.actions[1], id: "other" });
  if (change === "missing") payload.actions.pop();
  if (change === "selection-duplicate") payload.selection.actionIds.push("child");
  if (change === "selection-order") payload.selection.actionIds.reverse();
  if (change === "sequence-duplicate") payload.actions[1].seq = "1";
  if (change === "parent-missing") payload.actions[1].parentId = "missing";
  if (change === "parent-later") payload.actions[1].parentId = "skipped";
  if (change === "parent-cross-root") payload.actions[1].parentId = "empty-root";
  if (change === "root-parent") payload.actions[0].parentId = "child";
  if (change === "root-missing") {
    payload.actions.shift();
    payload.selection.actionIds.shift();
  }
  if (change === "unselected-root") payload.actions[1].rootId = "unselected";
  if (change === "contract") payload.actions[1].contractVersion = 98;
  if (change === "epoch") payload.actions[1].epochId = "other";
  if (change === "schema") payload.actions[1].schemaId = migrations.at(-2)!.id;
  if (change === "unbound-child") delete payload.actions[0].generated.skipped;
  if (change === "allocation") payload.actions[1].generated.clock.value = -124;
  expect(() => parseSharedRecoveryActionHistory(payload)).toThrow();
});

it.each([
  0,
  1,
  "0",
  "-1",
  "+1",
  "01",
  "1.0",
  "1e2",
  " 1",
  "1\n",
  "1\r",
  "9223372036854775808",
  "9".repeat(100),
])("refuses sequence %s without integer coercion", async (seq) => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options()),
    payload = clone(result.payload);
  payload.actions[4].seq = seq;
  expect(() => parseSharedRecoveryActionHistory(payload)).toThrow("SQLite INTEGER string");
});
it("retains the maximum positive signed SQLite sequence with gaps", async () => {
  const f = await fixture(),
    options = clone(f.options());
  options.actions[4].seq = "9223372036854775807";
  expect((await describeSharedRecoveryActions(options)).payload.actions[4].seq).toBe(
    "9223372036854775807",
  );
});

it.each(["root-input", "root-bindings", "child-kind", "child-parent", "child-missing"])(
  "refuses selected execution drift against original records for %s",
  async (change) => {
    const f = await fixture(),
      options = clone(f.options());
    if (change === "root-input") options.actions[0].input.a = "changed";
    if (change === "root-bindings") options.actions[0].generated.unused.value = "changed";
    if (change === "child-kind") options.actions[1].kind = "future.different";
    if (change === "child-parent") {
      options.actions[1].seq = "3";
      options.actions[2].seq = "2";
      options.selection.actionIds = ["root", "skipped", "child", "noop", "empty-root"];
      options.actions[1].parentId = "skipped";
    }
    if (change === "child-missing") {
      options.actions.splice(1, 1);
      options.selection.actionIds.splice(1, 1);
    }
    await expect(describeSharedRecoveryActions(options)).rejects.toThrow(
      /original root|matching original action/,
    );
  },
);

it.each([
  "original-input",
  "original-provenance",
  "unused-binding",
  "length",
  "digest",
  "source-descriptor",
  "execution-bytes",
  "shared-bytes",
  "truncated-selection",
])("requires trusted contents after %s changes", async (change) => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options());
  const payload = clone(result.payload),
    checkpoint = clone(result.checkpoint),
    executions = clone(f.executions.payload),
    shared = clone(f.source.payload);
  if (change === "original-input") payload.actions[2].input.ref = reference(9);
  if (change === "original-provenance") payload.actions[2].hlc = "changed";
  if (change === "unused-binding") payload.actions[0].generated.unused.value = "changed";
  if (change === "length") checkpoint.byteLength++;
  if (change === "digest") checkpoint.sha256 = "b".repeat(64);
  if (change === "source-descriptor") checkpoint.checkpoint.sha256 = "b".repeat(64);
  if (change === "execution-bytes") executions.effectSets[0].executions[1].input.ref = reference(9);
  if (change === "shared-bytes")
    shared.history.baseline.projection.tables
      .find((table: { name: string }) => table.name === "namespace")
      .rows.push({ id: ["text", "n"], name: ["text", "changed"], is_default: ["integer", "0"] });
  if (change === "truncated-selection") {
    payload.actions.splice(2, 1);
    payload.selection.actionIds.splice(2, 1);
    expect(() => parseSharedRecoveryActionHistory(payload)).not.toThrow();
  }
  await expect(
    requireSharedRecoveryActionCheckpoint(payload, checkpoint, identity, executions, shared),
  ).rejects.toThrow();
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires the host %s before hashing",
  async (field) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActions(f.options()),
      digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      requireSharedRecoveryActionCheckpoint(
        result.payload,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        f.executions.payload,
        f.source.payload,
      ),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);

it.each(["getter", "hook", "sparse", "undefined", "cycle", "nonfinite", "binding-getter"])(
  "refuses %s transport without invoking user code",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryActions(f.options()),
      payload = clone(result.payload),
      invoked = vi.fn();
    if (change === "getter")
      Object.defineProperty(payload.actions[1], "input", { enumerable: true, get: invoked });
    if (change === "hook") payload.actions[1].input.toJSON = invoked;
    if (change === "sparse") payload.actions[1].input = new Array(1);
    if (change === "undefined") payload.actions[1].input.extra = undefined;
    if (change === "cycle") payload.actions[1].input.cycle = payload.actions[1].input;
    if (change === "nonfinite") payload.actions[1].input = Infinity;
    if (change === "binding-getter")
      Object.defineProperty(payload.actions[0].generated, "unused", {
        enumerable: true,
        get: invoked,
      });
    expect(() => parseSharedRecoveryActionHistory(payload)).toThrow();
    expect(invoked).not.toHaveBeenCalled();
  },
);

it.each(["depth", "nodes", "string"])("bounds original input JSON %s", async (limit) => {
  const f = await fixture(),
    options = clone(f.options());
  let input: unknown = {};
  if (limit === "depth") for (let n = 0; n < 65; n++) input = { nested: input };
  if (limit === "nodes") input = Array.from({ length: 100001 }, () => null);
  if (limit === "string") input = "x".repeat(8 * 1024 * 1024 + 1);
  options.actions[2].input = input;
  await expect(describeSharedRecoveryActions(options)).rejects.toThrow();
});

it.each(["description", "verification"])(
  "owns original and source transport before hashing during %s",
  async (mode) => {
    const f = await fixture(),
      expected = await describeSharedRecoveryActions(f.options()),
      options = clone(f.options()),
      payload = clone(expected.payload),
      checkpoint = clone(expected.checkpoint),
      wantedIdentity = { ...identity };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      options.actions.length = 0;
      options.selection.actionIds.length = 0;
      options.executions.effectSets.length = 0;
      options.sharedHistory.history.effectSets.length = 0;
      options.checkpoint.sha256 = "b".repeat(64);
      payload.actions.length = 0;
      checkpoint.sha256 = "b".repeat(64);
      wantedIdentity.deviceId = "changed";
      return digest(...args);
    });
    const actual =
      mode === "description"
        ? (await describeSharedRecoveryActions(options)).payload
        : await requireSharedRecoveryActionCheckpoint(
            payload,
            checkpoint,
            wantedIdentity,
            options.executions,
            options.sharedHistory,
          );
    expect(actual).toEqual(expected.payload);
  },
);

it("reads historical action descriptors as metadata and refuses historical action payloads", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options()),
    old = clone(result.checkpoint);
  old.checkpoint.checkpoint.identity.schemaId = migrations.at(-2)!.id;
  expect(parseSharedRecoveryActionCheckpoint(old)).toEqual(old);
  expect(() =>
    parseSharedRecoveryActionHistory({ ...result.payload, checkpoint: old.checkpoint }),
  ).toThrow("Unsupported");
});

it.each([
  "version",
  "extra-field",
  "digest-case",
  "digest-length",
  "digest-newline",
  "zero-length",
  "count",
  "duplicate-selection",
  "missing-root-selection",
])("refuses malformed action descriptor %s", async (change) => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options()),
    checkpoint = clone(result.checkpoint);
  if (change === "version") checkpoint.version++;
  if (change === "extra-field") checkpoint.extra = true;
  if (change === "digest-case") checkpoint.sha256 = "A".repeat(64);
  if (change === "digest-length") checkpoint.sha256 = "a".repeat(65);
  if (change === "digest-newline") checkpoint.sha256 = "a".repeat(64) + "\n";
  if (change === "zero-length") checkpoint.byteLength = 0;
  if (change === "count") checkpoint.byteLength = 1.5;
  if (change === "duplicate-selection") checkpoint.selection.actionIds.push("root");
  if (change === "missing-root-selection") checkpoint.selection.actionIds.shift();
  expect(() => parseSharedRecoveryActionCheckpoint(checkpoint)).toThrow();
});

it("checks original invocation images including a deselected child and preserves extra requirements", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryActions(f.options());
  expect(sharedRecoveryActionAssetManifest(result.payload, manifest(0, 1, 3, 4, 5, 9))).toEqual(
    manifest(0, 1, 3, 4, 5, 9),
  );
  expect(() => sharedRecoveryActionAssetManifest(result.payload, manifest(0, 2, 3, 4, 5))).toThrow(
    "Required asset is missing",
  );
  expect(() => sharedRecoveryActionAssetManifest(result.payload, manifest(0, 1, 3, 4))).toThrow(
    "Required asset is missing",
  );
});

it("checks only invocation inputs for images and accepts their full supported nesting depth", async () => {
  const f = await fixture(),
    options = clone(f.options());
  let input: unknown = reference(5);
  for (let depth = 0; depth < 64; depth++) input = { nested: input };
  options.actions[2].input = input;
  options.actions[2].deviceId = reference(98);
  options.actions[2].hlc = reference(99);
  const result = await describeSharedRecoveryActions(options);
  expect(sharedRecoveryActionAssetManifest(result.payload, manifest(0, 1, 3, 4, 5))).toEqual(
    manifest(0, 1, 3, 4, 5),
  );
});

it("supports baseline-only expectations without original actions", async () => {
  const source = await describeSharedRecoveryHistory(
    { baseline: { id: "baseline", projection: emptyProjection() }, effectSets: [] },
    identity,
    { baselineId: "baseline", effectSets: [] },
  );
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: source.checkpoint,
    sharedHistory: source.payload,
    selection: { baselineId: "baseline", effectSets: [] },
    effectSets: [],
  });
  const result = await describeSharedRecoveryActions({
    actions: [],
    selection: { actionIds: [] },
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: source.payload,
  });
  expect(result.payload.actions).toEqual([]);
  expect(() =>
    parseSharedRecoveryActionCheckpoint({
      ...result.checkpoint,
      selection: { actionIds: ["unselected"] },
    }),
  ).toThrow("selected roots");
  expect(
    await requireSharedRecoveryActionCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      executions.payload,
      source.payload,
    ),
  ).toEqual(result.payload);
});

it("checks long original parent chains without recursive ancestry copies", async () => {
  const f = await fixture(),
    groups = clone(f.executions.payload.effectSets),
    actions = clone(f.actions),
    generated = actions[0].generated;
  const extra = Array.from({ length: 1000 }, (_, n) => ({
    id: `deep-${n}`,
    rootId: "root",
    parentId: n === 0 ? "root" : `deep-${n - 1}`,
    kind: "future.deep",
    contractVersion: 99,
    input: {},
    generated: {},
    ...provenance(String(n + 5)),
  }));
  for (const original of extra) generated[original.id] = { type: "child-id", value: original.id };
  for (const group of groups) if (group.invocation.id === "root") group.generated = generated;
  actions.splice(4, 0, ...extra);
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: f.source.checkpoint,
    sharedHistory: f.source.payload,
    selection: f.executions.payload.selection,
    effectSets: groups,
  });
  const result = await describeSharedRecoveryActions({
    ...f.options(),
    actions,
    selection: { actionIds: actions.map((action: { id: string }) => action.id) },
    checkpoint: executions.checkpoint,
    executions: executions.payload,
  });
  expect(result.payload.actions).toHaveLength(1005);
});

it("preserves first-recorded child inputs when real replay changes arguments and skips a child", async () => {
  const db = (await createTestDB()) as unknown as DB;
  type Context = { actions: ActionFrameAccess };
  let replaying = false,
    next = 0;
  const registry = defineActionRegistry<
    { root: unknown; child: unknown; skipped: unknown },
    Context
  >({
    contractVersion: 1,
    schemaVersions: [migrations.at(-1)!.idx],
    definitions: {
      root: {
        eligibility: "syncable",
        prepare: (value) => value,
        replay: async (_input, { context }) => {
          await context.actions.child(["child"], "child", { ref: reference(replaying ? 2 : 1) });
          if (!replaying)
            await context.actions.child(["skipped"], "skipped", { ref: reference(3) });
        },
      },
      child: { eligibility: "syncable", prepare: (value) => value, replay: async () => undefined },
      skipped: {
        eligibility: "syncable",
        prepare: (value) => value,
        replay: async () => undefined,
      },
    },
  });
  const invocation = { id: "root", kind: "root", contractVersion: 1, input: { ref: reference(0) } };
  const first = await runActionGroup({
    db,
    registry,
    schemaVersion: migrations.at(-1)!.idx,
    invocation,
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => `child-${++next}`,
      now: () => 1,
    }),
    createContext: (actions) => ({ actions }),
  });
  replaying = true;
  const replay = await runActionGroup({
    db,
    registry,
    schemaVersion: migrations.at(-1)!.idx,
    invocation,
    bindings: createActionBindings({ mode: "replay", bindings: first.generated }),
    createContext: (actions) => ({ actions }),
  });
  const source = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: emptyProjection() },
      effectSets: [{ id: "rebase", effects: [] }],
    },
    identity,
    { baselineId: "baseline", effectSets: [{ id: "rebase", effectCount: 0 }] },
  );
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: source.checkpoint,
    sharedHistory: source.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [{ id: "rebase", rootId: "root", executionCount: 2 }],
    },
    effectSets: [
      {
        id: "rebase",
        invocation: replay.invocation,
        generated: replay.generated,
        executions: replay.executions,
        effects: [],
      },
    ],
  });
  const actions = first.executions.map(({ executionOrd, ...entry }) => ({
    ...entry,
    rootId: "root",
    generated: executionOrd === 0 ? first.generated : entry.generated,
    ...provenance(String(executionOrd + 1)),
  }));
  const result = await describeSharedRecoveryActions({
    actions,
    selection: { actionIds: ["root", "child-1", "child-2"] },
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: source.payload,
  });
  expect(result.payload.actions[1].input).toEqual({ ref: reference(1) });
  expect(replay.executions[1].input).toEqual({ ref: reference(2) });
  expect(result.payload.actions[2].input).toEqual({ ref: reference(3) });
  expect(sharedRecoveryActionAssetManifest(result.payload, manifest(0, 1, 3))).toEqual(
    manifest(0, 1, 3),
  );
});
