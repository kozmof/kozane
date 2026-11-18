import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { migrations } from "../../../../core/src/generated/migrations.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import {
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import {
  describeSharedRecoveryExecutions,
  parseSharedRecoveryExecutionHistory,
  parseSharedRecoveryExecutionCheckpoint,
  requireSharedRecoveryExecutionCheckpoint,
  sharedRecoveryExecutionAssetManifest,
} from "../../../../core/src/actions/shared-recovery-executions.js";
import { sharedRecoveryAssetManifest } from "../../../../core/src/actions/shared-recovery-assets.js";
import { createTestDB } from "../../test-utils/db.js";
import { capturedTables, installCapturePrototype } from "../../test-utils/action-capture.js";

const identity = {
  workspaceId: "workspace",
  deviceId: "device",
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
const row = (n: number) => ({
  id: ["text", "n"] as const,
  name: ["text", reference(n)] as const,
  is_default: ["integer", "0"] as const,
});
const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
const invocation = (id: string, ref: number) => ({
  id,
  kind: "named.recovery",
  contractVersion: 2,
  input: { args: {}, body: { ref: reference(ref), text: '\ufeff{"json":"unchanged"}\0🪁' } },
});
const child = (value: string) => ({ type: "child-id" as const, value });
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
      baseline: {
        id: "baseline",
        projection: {
          version: 1,
          rowEncodingVersion: 1,
          schemaId: identity.schemaId,
          tables: capturedTables.map(({ name }) => ({ name, rows: [] })),
        },
      },
      effectSets: [
        {
          id: "edit",
          effects: [
            {
              ord: 0,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "I",
              before: null,
              after: row(1),
            },
            {
              ord: 1,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "U",
              before: row(1),
              after: row(2),
            },
            {
              ord: 2,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "D",
              before: row(2),
              after: null,
            },
          ],
        },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", effectCount: 3 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  const root = invocation("root", 0),
    a = invocation("a", 1),
    b = invocation("b", 2),
    c = invocation("c", 3);
  const empty = invocation("empty-root", 4);
  const generated: ActionBindingMap = {
    a: child("a"),
    b: child("b"),
    c: child("c"),
    unused: { type: "entity-id", value: "unused" },
    clock: { type: "clock", value: -123 },
  };
  const groups = [
    {
      id: "edit",
      invocation: root,
      generated,
      executions: [
        { ...root, parentId: null, executionOrd: 0, generated: { a: generated.a, c: generated.c } },
        {
          ...a,
          parentId: "root",
          executionOrd: 1,
          generated: { b: generated.b, clock: generated.clock },
        },
        { ...b, parentId: "a", executionOrd: 2, generated: {} },
        { ...c, parentId: "root", executionOrd: 3, generated: {} },
      ],
      effects: [
        { ord: 0, actionId: "root", executionOrd: 0 },
        { ord: 1, actionId: "b", executionOrd: 2 },
        { ord: 2, actionId: "root", executionOrd: 0 },
      ],
    },
    {
      id: "empty",
      invocation: empty,
      generated: {},
      executions: [{ ...empty, parentId: null, executionOrd: 0, generated: {} }],
      effects: [],
    },
  ];
  const selection = {
    baselineId: "baseline",
    effectSets: [
      { id: "edit", rootId: "root", executionCount: 4 },
      { id: "empty", rootId: "empty-root", executionCount: 1 },
    ],
  };
  const images = {
    baseline: { id: "baseline", manifest: manifest(5) },
    effectSets: [
      { id: "edit", manifest: manifest(0, 1, 2, 3) },
      { id: "empty", manifest: manifest(4) },
    ],
  };
  const options = () => ({
    effectSets: groups,
    checkpoint: source.checkpoint,
    selection,
    sharedHistory: source.payload,
  });
  return { source, groups, selection, images, options };
}

it("binds roots, no-op children, resolved inputs, bindings and complete effect attribution to shared history", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.options());
  const result = await describeSharedRecoveryExecutions(f.options());
  expect(result.payload.effectSets[0].executions).toHaveLength(4);
  expect(result.payload.effectSets[0].executions[3].id).toBe("c");
  expect(result.payload.effectSets[1].effects).toEqual([]);
  expect(result.payload.effectSets[1].executions).toHaveLength(1);
  expect(result.payload.effectSets[0].generated.unused).toEqual({
    type: "entity-id",
    value: "unused",
  });
  expect(result.checkpoint.byteLength).toBe(
    new TextEncoder().encode(JSON.stringify(result.payload)).length,
  );
  expect(result.checkpoint.byteLength).toBeGreaterThan(JSON.stringify(result.payload).length);
  expect(
    await requireSharedRecoveryExecutionCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      f.source.payload,
    ),
  ).toEqual(result.payload);
  expect(Object.isFrozen(result.payload.effectSets[0].executions[0].input)).toBe(true);
  expect(Object.isFrozen(result.payload.effectSets[0].effects[0])).toBe(true);
  expect(Object.isFrozen(result.payload.effectSets[0].generated.a)).toBe(true);
  expect(JSON.stringify(f.options())).toBe(before);
});

it("canonicalizes record and JSON field ordering while preserving execution and effect ordinals", async () => {
  const f = await fixture();
  const expected = await describeSharedRecoveryExecutions(f.options());
  const input = clone(expected.payload);
  input.effectSets.reverse();
  input.effectSets[1].executions.reverse();
  input.effectSets[1].effects.reverse();
  input.effectSets[1].executions[0].input = Object.fromEntries(
    Object.entries(input.effectSets[1].executions[0].input).reverse(),
  );
  expect(parseSharedRecoveryExecutionHistory(input)).toEqual(expected.payload);
  expect(
    await requireSharedRecoveryExecutionCheckpoint(
      input,
      expected.checkpoint,
      identity,
      f.source.payload,
    ),
  ).toEqual(expected.payload);
});

it.each(["noop-input", "unused-binding", "clock", "attribution", "embedded-json"])(
  "detects %s changes with the same shared row checkpoint",
  async (change) => {
    const f = await fixture();
    const expected = await describeSharedRecoveryExecutions(f.options());
    const effectSets = clone(f.groups);
    if (change === "noop-input") effectSets[0].executions[3].input.body.ref = reference(9);
    if (change === "unused-binding") effectSets[0].generated.unused.value = "edited";
    if (change === "clock") {
      effectSets[0].generated.clock.value = 1;
      effectSets[0].executions[1].generated.clock.value = 1;
    }
    if (change === "attribution")
      effectSets[0].effects[1] = { ord: 1, actionId: "a", executionOrd: 1 };
    if (change === "embedded-json")
      effectSets[0].executions[3].input.body.text = '\ufeff{ "json": "unchanged" }\0🪁';
    const actual = await describeSharedRecoveryExecutions({ ...f.options(), effectSets });
    expect(actual.checkpoint.sha256).not.toBe(expected.checkpoint.sha256);
    await expect(
      requireSharedRecoveryExecutionCheckpoint(
        actual.payload,
        expected.checkpoint,
        identity,
        f.source.payload,
      ),
    ).rejects.toThrow("content mismatch");
  },
);

it.each([
  "missing-set",
  "extra-set",
  "duplicate-set",
  "missing-noop",
  "ordinal-gap",
  "duplicate-action",
  "root",
  "parent",
  "contract",
  "root-input",
  "unbound-child",
  "unbound-allocation",
])("refuses %s execution transport", async (change) => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  if (change === "missing-set") effectSets.pop();
  if (change === "extra-set") effectSets.push({ ...effectSets[1], id: "extra" });
  if (change === "duplicate-set") effectSets[1].id = "edit";
  if (change === "missing-noop") effectSets[0].executions.pop();
  if (change === "ordinal-gap") effectSets[0].executions[3].executionOrd = 4;
  if (change === "duplicate-action") effectSets[0].executions[3].id = "a";
  if (change === "root") effectSets[0].invocation.id = "another-root";
  if (change === "parent") effectSets[0].executions[2].parentId = "absent";
  if (change === "contract") effectSets[0].executions[2].contractVersion = 1;
  if (change === "root-input") effectSets[0].executions[0].input.body.ref = reference(8);
  if (change === "unbound-child") delete effectSets[0].executions[0].generated.c;
  if (change === "unbound-allocation") effectSets[0].executions[1].generated.clock.value = 1;
  await expect(describeSharedRecoveryExecutions({ ...f.options(), effectSets })).rejects.toThrow();
});

it.each(["count", "root-id", "baseline", "set-order"])(
  "refuses changed expected %s",
  async (change) => {
    const f = await fixture();
    const selection = clone(f.selection);
    if (change === "count") selection.effectSets[0].executionCount = 3;
    if (change === "root-id") selection.effectSets[0].rootId = "other";
    if (change === "baseline") selection.baselineId = "other";
    if (change === "set-order") selection.effectSets.reverse();
    await expect(describeSharedRecoveryExecutions({ ...f.options(), selection })).rejects.toThrow();
  },
);

it.each([
  "missing",
  "duplicate",
  "unknown-action",
  "wrong-execution",
  "late-child",
  "reopened-ancestor",
])("refuses %s effect attribution", async (change) => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  if (change === "missing") effectSets[0].effects.pop();
  if (change === "duplicate") effectSets[0].effects[1].ord = 0;
  if (change === "unknown-action") effectSets[0].effects[1].actionId = "absent";
  if (change === "wrong-execution") effectSets[0].effects[1].executionOrd = 1;
  if (change === "late-child")
    effectSets[0].effects = [
      { ord: 0, actionId: "b", executionOrd: 2 },
      { ord: 1, actionId: "root", executionOrd: 0 },
      { ord: 2, actionId: "b", executionOrd: 2 },
    ];
  if (change === "reopened-ancestor") {
    effectSets[0].generated.c = child("c");
    effectSets[0].executions[1].generated.c = child("c");
    effectSets[0].executions[3].parentId = "a";
    effectSets[0].effects = [
      { ord: 0, actionId: "b", executionOrd: 2 },
      { ord: 1, actionId: "root", executionOrd: 0 },
      { ord: 2, actionId: "c", executionOrd: 3 },
    ];
  }
  await expect(describeSharedRecoveryExecutions({ ...f.options(), effectSets })).rejects.toThrow();
});

it("refuses execution entry order that reenters an earlier sibling's subtree", async () => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  effectSets[0].executions[2].parentId = "root";
  effectSets[0].executions[0].generated.b = child("b");
  effectSets[0].executions[3].parentId = "a";
  effectSets[0].executions[1].generated.c = child("c");
  await expect(describeSharedRecoveryExecutions({ ...f.options(), effectSets })).rejects.toThrow(
    "parent or entry order",
  );
});

it("refuses the same action identity claimed by different roots", async () => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  effectSets[1].invocation.id = "c";
  effectSets[1].executions[0].id = "c";
  const selection = clone(f.selection);
  selection.effectSets[1].rootId = "c";
  await expect(
    describeSharedRecoveryExecutions({ ...f.options(), effectSets, selection }),
  ).rejects.toThrow("identity changes between");
});

it("binds attribution to the exact source history even when final rows are unchanged", async () => {
  const f = await fixture();
  const result = await describeSharedRecoveryExecutions(f.options());
  const source = clone(f.source.payload);
  source.history.effectSets[0].effects[1].after.name = ["text", reference(7)];
  source.history.effectSets[0].effects[2].before.name = ["text", reference(7)];
  await expect(
    describeSharedRecoveryExecutions({ ...f.options(), sharedHistory: source }),
  ).rejects.toThrow("content mismatch");
  await expect(
    requireSharedRecoveryExecutionCheckpoint(result.payload, result.checkpoint, identity, source),
  ).rejects.toThrow("content mismatch");
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires the host's expected %s before hashing",
  async (field) => {
    const f = await fixture();
    const result = await describeSharedRecoveryExecutions(f.options());
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      requireSharedRecoveryExecutionCheckpoint(
        result.payload,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        f.source.payload,
      ),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);

it.each(["version", "length", "hash", "binding", "count"])(
  "refuses a changed expected descriptor %s",
  async (change) => {
    const f = await fixture();
    const result = await describeSharedRecoveryExecutions(f.options());
    const expected = clone(result.checkpoint);
    if (change === "version") expected.version = 2;
    if (change === "length") expected.byteLength++;
    if (change === "hash") expected.sha256 = "b".repeat(64);
    if (change === "binding") expected.checkpoint.sha256 = "b".repeat(64);
    if (change === "count") expected.selection.effectSets[0].executionCount++;
    await expect(
      requireSharedRecoveryExecutionCheckpoint(
        result.payload,
        expected,
        identity,
        f.source.payload,
      ),
    ).rejects.toThrow();
  },
);

it("requires invocation-only images from no-op children and zero-effect selected sets", async () => {
  const f = await fixture();
  const result = await describeSharedRecoveryExecutions(f.options());
  expect(sharedRecoveryExecutionAssetManifest(result.payload, f.images)).toEqual(
    manifest(0, 1, 2, 3, 4, 5),
  );
  expect(sharedRecoveryAssetManifest(f.source.payload, f.images)).toEqual(
    manifest(0, 1, 2, 3, 4, 5),
  );
  for (const image of [0, 3, 4]) {
    const missing = clone(f.images);
    for (const set of missing.effectSets)
      set.manifest.entries = set.manifest.entries.filter(
        (entry: { name: string }) => !entry.name.endsWith(filename(image)),
      );
    expect(() => sharedRecoveryAssetManifest(f.source.payload, missing)).not.toThrow();
    expect(() => sharedRecoveryExecutionAssetManifest(result.payload, missing)).toThrow(
      "Required asset is missing",
    );
  }
});

it("refuses image manifest selection mismatches and conflicting immutable names", async () => {
  const f = await fixture();
  const result = await describeSharedRecoveryExecutions(f.options());
  const reordered = clone(f.images);
  reordered.effectSets.reverse();
  expect(() => sharedRecoveryExecutionAssetManifest(result.payload, reordered)).toThrow(
    "image selection mismatch",
  );
  const conflict = clone(f.images);
  conflict.baseline.manifest = manifest(0);
  conflict.baseline.manifest.entries[0].sha256 = "b".repeat(64);
  expect(() => sharedRecoveryExecutionAssetManifest(result.payload, conflict)).toThrow(
    "Conflicting asset bytes",
  );
});

it.each(["undefined", "nonfinite", "cycle", "sparse", "hook", "binding-type", "binding-clock"])(
  "rejects invalid %s data without silently dropping it",
  async (change) => {
    const f = await fixture();
    const effectSets = clone(f.groups);
    if (change === "undefined") effectSets[0].executions[3].input.body.extra = undefined;
    if (change === "nonfinite") effectSets[0].executions[3].input.body.extra = Infinity;
    if (change === "cycle")
      effectSets[0].executions[3].input.body.extra = effectSets[0].executions[3].input;
    if (change === "sparse") effectSets[0].executions[3].input.body.extra = new Array(2);
    const hook = vi.fn();
    if (change === "hook")
      Object.defineProperty(effectSets[0].executions[3].input.body, "toJSON", {
        enumerable: true,
        get: hook,
      });
    if (change === "binding-type") effectSets[0].generated.unused.type = "unknown";
    if (change === "binding-clock") effectSets[0].generated.clock.value = 1.5;
    await expect(
      describeSharedRecoveryExecutions({ ...f.options(), effectSets }),
    ).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
  },
);

it("refuses getters and sparse execution arrays without invoking them", async () => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  const getter = vi.fn();
  Object.defineProperty(effectSets[0].executions[3], "input", { enumerable: true, get: getter });
  await expect(describeSharedRecoveryExecutions({ ...f.options(), effectSets })).rejects.toThrow(
    "plain data fields",
  );
  expect(getter).not.toHaveBeenCalled();
  effectSets[0].executions = new Array(4);
  await expect(describeSharedRecoveryExecutions({ ...f.options(), effectSets })).rejects.toThrow(
    "execution array",
  );
});

it("preserves JSON keys safely and normalizes negative zero according to JSON semantics", async () => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  effectSets[0].executions[3].input.body = JSON.parse('{"__proto__":{"polluted":true},"zero":0}');
  effectSets[0].executions[3].input.body.zero = -0;
  const result = await describeSharedRecoveryExecutions({ ...f.options(), effectSets });
  const body = (
    result.payload.effectSets[0].executions[3].input as { body: Record<string, unknown> }
  ).body;
  expect(Object.hasOwn(body, "__proto__")).toBe(true);
  expect(Object.is(body.zero, -0)).toBe(false);
  expect(Object.hasOwn({}, "polluted")).toBe(false);
});

it("keeps unsupported contract versions and kinds as data without invoking handlers", async () => {
  const f = await fixture();
  const effectSets = clone(f.groups);
  for (const set of effectSets) {
    set.invocation.contractVersion = 999;
    set.invocation.kind = "future.root";
    for (const entry of set.executions) {
      entry.contractVersion = 999;
      entry.kind = entry.executionOrd === 0 ? "future.root" : "future.child";
    }
  }
  const result = await describeSharedRecoveryExecutions({ ...f.options(), effectSets });
  expect(
    await requireSharedRecoveryExecutionCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      f.source.payload,
    ),
  ).toEqual(result.payload);
});

it("reads historical descriptors as metadata while refusing old-schema execution payloads", async () => {
  const f = await fixture();
  const result = await describeSharedRecoveryExecutions(f.options());
  const old = clone(result.checkpoint);
  old.checkpoint.identity.schemaId = migrations.at(-2)!.id;
  expect(parseSharedRecoveryExecutionCheckpoint(old)).toEqual(old);
  expect(() =>
    parseSharedRecoveryExecutionHistory({ ...result.payload, checkpoint: old.checkpoint }),
  ).toThrow("Unsupported");
});

it.each(["description", "verification"])(
  "owns every input before hashing during %s",
  async (mode) => {
    const f = await fixture();
    const expected = await describeSharedRecoveryExecutions(f.options());
    const options = clone(f.options()),
      payload = clone(expected.payload),
      checkpoint = clone(expected.checkpoint),
      wantedIdentity = { ...identity };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      options.effectSets.length = 0;
      options.selection.effectSets.length = 0;
      options.checkpoint.sha256 = "b".repeat(64);
      options.sharedHistory.history.effectSets.length = 0;
      payload.effectSets.length = 0;
      checkpoint.sha256 = "b".repeat(64);
      wantedIdentity.deviceId = "changed";
      return digest(...args);
    });
    const result =
      mode === "description"
        ? (await describeSharedRecoveryExecutions(options)).payload
        : await requireSharedRecoveryExecutionCheckpoint(
            payload,
            checkpoint,
            wantedIdentity,
            options.sharedHistory,
          );
    expect(result).toEqual(expected.payload);
  },
);

it("accepts persisted capture scopes with no-op children and exact SQL effect attribution", async () => {
  const db = (await createTestDB()) as unknown as DB;
  const capture = await installCapturePrototype(db, manifest(0, 1, 2, 3, 4));
  type Context = { db: Tx; actions: ActionFrameAccess };
  const registry = defineActionRegistry<{ root: unknown; branch: unknown; noop: unknown }, Context>(
    {
      contractVersion: 1,
      schemaVersions: [migrations.at(-1)!.idx],
      definitions: {
        root: {
          eligibility: "syncable",
          prepare: (value) => value,
          replay: async (_input, { context }) => {
            await context.db.run(sql`INSERT INTO namespace(id,name) VALUES('n',${reference(1)})`);
            await context.actions.child(["branch"], "branch", { ref: reference(3) });
            await context.db.run(sql`DELETE FROM namespace`);
          },
        },
        branch: {
          eligibility: "syncable",
          prepare: (value) => value,
          replay: async (_input, { context }) => {
            await context.actions.child(["noop"], "noop", { ref: reference(4) });
            await context.db.run(sql`UPDATE namespace SET name=${reference(2)}`);
          },
        },
        noop: { eligibility: "syncable", prepare: (value) => value, replay: async () => undefined },
      },
    },
  );
  let next = 0;
  await runActionGroup({
    db,
    schemaVersion: migrations.at(-1)!.idx,
    registry,
    invocation: { id: "root", kind: "root", contractVersion: 1, input: { ref: reference(0) } },
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => `child-${++next}`,
      now: () => 1,
    }),
    createContext: (actions, db) => ({ actions, db }),
    ...capture.hooks("captured"),
  });
  const [run] = await capture.runs(),
    entries = await capture.executions("captured"),
    effects = await capture.effects("captured");
  const source = await describeSharedRecoveryHistory(
    {
      baseline: {
        id: "baseline",
        projection: {
          version: 1,
          rowEncodingVersion: 1,
          schemaId: identity.schemaId,
          tables: capturedTables.map(({ name }) => ({ name, rows: [] })),
        },
      },
      effectSets: [
        {
          id: "captured",
          effects: effects.map(({ ord, table, key, op, before, after }) => ({
            ord,
            table,
            key,
            op,
            before,
            after,
          })),
        },
      ],
    },
    identity,
    { baselineId: "baseline", effectSets: [{ id: "captured", effectCount: effects.length }] },
  );
  const result = await describeSharedRecoveryExecutions({
    checkpoint: source.checkpoint,
    sharedHistory: source.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [{ id: "captured", rootId: "root", executionCount: entries.length }],
    },
    effectSets: [
      {
        id: "captured",
        invocation: JSON.parse(run.invocation!),
        generated: JSON.parse(run.generated!),
        executions: entries.map((entry) => ({
          ...entry,
          input: JSON.parse(entry.input),
          generated: JSON.parse(entry.generated!),
        })),
        effects: effects.map(({ ord, actionId, executionOrd }) => ({
          ord,
          actionId,
          executionOrd,
        })),
      },
    ],
  });
  expect(result.payload.effectSets[0].executions).toHaveLength(3);
  expect(result.payload.effectSets[0].effects.map(({ executionOrd }) => executionOrd)).toEqual([
    0, 1, 0,
  ]);
  const images = {
    baseline: { id: "baseline", manifest: capture.baselineManifest },
    effectSets: [{ id: "captured", manifest: JSON.parse(run.assets!) }],
  };
  expect(sharedRecoveryExecutionAssetManifest(result.payload, images)).toEqual(
    manifest(0, 1, 2, 3, 4),
  );
  expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});

it("accepts a baseline-only checkpoint with no selected executions", async () => {
  const f = await fixture();
  const source = await describeSharedRecoveryHistory(
    { baseline: f.source.payload.history.baseline, effectSets: [] },
    identity,
    { baselineId: "baseline", effectSets: [] },
  );
  const result = await describeSharedRecoveryExecutions({
    effectSets: [],
    checkpoint: source.checkpoint,
    selection: { baselineId: "baseline", effectSets: [] },
    sharedHistory: source.payload,
  });
  expect(result.payload.effectSets).toEqual([]);
  expect(
    await requireSharedRecoveryExecutionCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      source.payload,
    ),
  ).toEqual(result.payload);
});

it("refuses a truncated no-op child list even when received counts are lowered to match", async () => {
  const f = await fixture();
  const result = await describeSharedRecoveryExecutions(f.options());
  const payload = clone(result.payload);
  payload.effectSets[0].executions.pop();
  payload.selection.effectSets[0].executionCount--;
  expect(() => parseSharedRecoveryExecutionHistory(payload)).not.toThrow();
  await expect(
    requireSharedRecoveryExecutionCheckpoint(
      payload,
      result.checkpoint,
      identity,
      f.source.payload,
    ),
  ).rejects.toThrow("binding mismatch");
});

it("handles deep execution trees and returns from descendant effects without recursive ancestry copies", async () => {
  const f = await fixture();
  const effectSets = clone(f.groups),
    selection = clone(f.selection);
  const count = 1000;
  const actionId = (n: number) => (n === 0 ? "root" : `deep-${n}`);
  effectSets[0].generated = Object.fromEntries(
    Array.from({ length: count - 1 }, (_, n) => [`next-${n + 1}`, child(actionId(n + 1))]),
  );
  effectSets[0].executions = Array.from({ length: count }, (_, n) => ({
    ...(n === 0
      ? effectSets[0].invocation
      : { id: actionId(n), kind: "named.recovery", contractVersion: 2, input: {} }),
    parentId: n === 0 ? null : actionId(n - 1),
    executionOrd: n,
    generated: n + 1 < count ? { [`next-${n + 1}`]: child(actionId(n + 1)) } : {},
  }));
  effectSets[0].effects = [999, 500, 0].map((executionOrd, ord) => ({
    ord,
    actionId: actionId(executionOrd),
    executionOrd,
  }));
  selection.effectSets[0].executionCount = count;
  const result = await describeSharedRecoveryExecutions({ ...f.options(), effectSets, selection });
  expect(result.payload.effectSets[0].executions).toHaveLength(count);
  expect(
    await requireSharedRecoveryExecutionCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      f.source.payload,
    ),
  ).toEqual(result.payload);
});

it.each(["depth", "nodes", "string"])(
  "enforces strict invocation JSON %s limits",
  async (limit) => {
    const f = await fixture();
    const effectSets = clone(f.groups);
    let value: unknown;
    if (limit === "depth") {
      value = {};
      for (let n = 0; n < 65; n++) value = { nested: value };
    }
    if (limit === "nodes") value = Array.from({ length: 100001 }, () => null);
    if (limit === "string") value = "x".repeat(8 * 1024 * 1024 + 1);
    effectSets[0].executions[3].input.body.extra = value;
    await expect(
      describeSharedRecoveryExecutions({ ...f.options(), effectSets }),
    ).rejects.toThrow();
  },
);
