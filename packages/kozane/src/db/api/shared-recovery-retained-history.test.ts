import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { migrations } from "@kozane/core/migrations";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  type DatabaseHandle,
} from "@kozane/core/database";
import {
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryActions,
  describeSharedRecoveryRetainedHistory,
  parseSharedRecoveryRetainedHistory,
  parseSharedRecoveryRetainedCheckpoint,
  requireSharedRecoveryRetainedCheckpoint,
  validateSharedRecoveryRetainedHistory,
  sharedRecoveryRetainedAssetManifest,
  type SharedRecoveryEffectSetSource,
  type SharedRecoveryHistoryPayload,
  type SharedRecoveryExecutionHistory,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { capturedTables } from "../../test-utils/action-capture.js";
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
const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
const row = (n: number) => ({
  id: ["text", "n"] as const,
  name: ["text", reference(n)] as const,
  is_default: ["integer", "0"] as const,
});
const projection = (n?: number) => ({
  version: 1,
  rowEncodingVersion: 1,
  schemaId: identity.schemaId,
  tables: capturedTables.map(({ name }) => ({
    name,
    rows: name === "namespace" && n !== undefined ? [row(n)] : [],
  })),
});
const effect = (
  ord: number,
  before: ReturnType<typeof row> | null,
  after: ReturnType<typeof row> | null,
) => ({
  ord,
  table: "namespace",
  key: { id: ["text", "n"] },
  op: before === null ? "I" : after === null ? "D" : "U",
  before,
  after,
});
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const root = {
    id: "root",
    kind: "future.root",
    contractVersion: 99,
    input: { ref: reference(7), text: '\ufeff{"exact":true}\0🪁' },
  };
  const generated = {
    child: { type: "child-id", value: "child" },
    skipped: { type: "child-id", value: "skipped" },
    unused: { type: "entity-id", value: "unused" },
    clock: { type: "clock", value: -123 },
  };
  const group = (id: string, childRef?: number, skipped = false) => ({
    id,
    invocation: root,
    generated,
    executions: [
      {
        ...root,
        parentId: null,
        executionOrd: 0,
        generated: {
          ...(childRef !== undefined ? { child: generated.child } : {}),
          ...(skipped ? { skipped: generated.skipped } : {}),
        },
      },
      ...(childRef !== undefined
        ? [
            {
              id: "child",
              kind: "future.child",
              contractVersion: 99,
              input: { ref: reference(childRef) },
              parentId: "root",
              executionOrd: 1,
              generated: {},
            },
          ]
        : []),
      ...(skipped
        ? [
            {
              id: "skipped",
              kind: "future.skipped",
              contractVersion: 99,
              input: { ref: reference(8) },
              parentId: "root",
              executionOrd: 2,
              generated: {},
            },
          ]
        : []),
    ],
    effects:
      id === "rebase"
        ? [{ ord: 0, actionId: "child", executionOrd: 1 }]
        : childRef === undefined
          ? [
              { ord: 0, actionId: "root", executionOrd: 0 },
              { ord: 1, actionId: "root", executionOrd: 0 },
            ]
          : [
              { ord: 0, actionId: "child", executionOrd: 1 },
              { ord: 1, actionId: "root", executionOrd: 0 },
            ],
  });
  const rebase = group("rebase", 3),
    authoritative = group("authoritative");
  const rowSets = [
    { id: "rebase", effects: [effect(0, null, row(2))] },
    { id: "authoritative", effects: [effect(0, row(2), row(4)), effect(1, row(4), null)] },
  ];
  const shared = await describeSharedRecoveryHistory(
    { baseline: { id: "current-baseline", projection: projection() }, effectSets: rowSets },
    identity,
    {
      baselineId: "current-baseline",
      effectSets: [
        { id: "rebase", effectCount: 1 },
        { id: "authoritative", effectCount: 2 },
      ],
    },
  );
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: {
      baselineId: "current-baseline",
      effectSets: [
        { id: "rebase", rootId: "root", executionCount: 2 },
        { id: "authoritative", rootId: "root", executionCount: 1 },
      ],
    },
    effectSets: [rebase, authoritative],
  });
  const provenance = {
    deviceId: "first-record-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
    hlc: "opaque:first-record",
  };
  const originals = await describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: { actionIds: ["root", "child", "skipped"] },
    actions: [
      { ...root, rootId: "root", parentId: null, generated, seq: "1", ...provenance },
      {
        id: "child",
        rootId: "root",
        parentId: "root",
        kind: "future.child",
        contractVersion: 99,
        input: { ref: reference(5) },
        generated: {},
        seq: "2",
        ...provenance,
      },
      {
        id: "skipped",
        rootId: "root",
        parentId: "root",
        kind: "future.skipped",
        contractVersion: 99,
        input: { ref: reference(8) },
        generated: {},
        seq: "9007199254740993",
        ...provenance,
      },
    ],
  });
  async function run(
    id: string,
    source: SharedRecoveryEffectSetSource,
    before: number | undefined,
    rows: (typeof rowSets)[number],
    execution: ReturnType<typeof group>,
  ) {
    const baselineId = `before-${id}`;
    const history = await describeSharedRecoveryHistory(
      { baseline: { id: baselineId, projection: projection(before) }, effectSets: [rows] },
      identity,
      { baselineId, effectSets: [{ id, effectCount: rows.effects.length }] },
    );
    const selected = await describeSharedRecoveryExecutions({
      checkpoint: history.checkpoint,
      sharedHistory: history.payload,
      selection: {
        baselineId,
        effectSets: [{ id, rootId: "root", executionCount: execution.executions.length }],
      },
      effectSets: [execution],
    });
    return { id, rootId: "root", source, history: history.payload, executions: selected.payload };
  }
  const effectSets = [
    await run(
      "origin",
      "origin",
      0,
      { id: "origin", effects: [effect(0, row(0), row(1)), effect(1, row(1), null)] },
      group("origin", 5, true),
    ),
    await run("authoritative", "authoritative", 2, rowSets[1], authoritative),
    await run(
      "superseded",
      "rebase",
      9,
      { id: "superseded", effects: [effect(0, row(9), row(10)), effect(1, row(10), null)] },
      group("superseded", 11),
    ),
    await run("rebase", "rebase", undefined, rowSets[0], rebase),
  ];
  const selection = {
    effectSets: effectSets.map((set) => ({
      id: set.id,
      rootId: set.rootId,
      source: set.source,
      baselineId: set.history.selection.baselineId,
      effectCount: set.history.selection.effectSets[0].effectCount,
      executionCount: set.executions.selection.effectSets[0].executionCount,
    })),
  };
  const images = {
    effectSets: effectSets.map((set) => ({
      id: set.id,
      history: {
        baseline: {
          id: set.history.selection.baselineId,
          manifest:
            set.id === "origin"
              ? manifest(0)
              : set.id === "authoritative"
                ? manifest(2)
                : set.id === "superseded"
                  ? manifest(9)
                  : manifest(),
        },
        effectSets: [
          {
            id: set.id,
            manifest:
              set.id === "origin"
                ? manifest(0, 1, 5, 7, 8)
                : set.id === "authoritative"
                  ? manifest(2, 4, 7)
                  : set.id === "superseded"
                    ? manifest(7, 9, 10, 11)
                    : manifest(2, 3, 7),
          },
        ],
      },
    })),
  };
  return {
    shared,
    executions,
    originals,
    selection,
    effectSets,
    images,
    options: () => ({
      checkpoint: originals.checkpoint,
      selection,
      effectSets,
      originals: originals.payload,
      executions: executions.payload,
      sharedHistory: shared.payload,
    }),
  };
}
async function redescribeSet(set: {
  id: string;
  history: SharedRecoveryHistoryPayload;
  executions: SharedRecoveryExecutionHistory;
}) {
  const shared = await describeSharedRecoveryHistory(
    set.history.history,
    identity,
    set.history.selection,
  );
  set.history = shared.payload;
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: set.executions.selection,
    effectSets: set.executions.effectSets,
  });
  set.executions = executions.payload;
}
it("binds origin, superseded and selected runs without applying deselected effects to the current reconstruction", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options());
  expect(result.payload.effectSets.map(({ id }) => id)).toEqual([
    "origin",
    "authoritative",
    "superseded",
    "rebase",
  ]);
  expect(f.shared.projection.tables.every(({ rows }) => rows.length === 0)).toBe(true);
  expect(result.payload.effectSets[0].executions.effectSets[0].executions[1].input).toEqual({
    ref: reference(5),
  });
  expect(result.payload.effectSets[2].executions.effectSets[0].executions[1].input).toEqual({
    ref: reference(11),
  });
  expect(result.payload.effectSets[3].executions.effectSets[0].executions[1].input).toEqual({
    ref: reference(3),
  });
  expect(result.payload.effectSets[0].executions.effectSets[0].executions[2].id).toBe("skipped");
  expect(Object.isFrozen(result.payload.effectSets[0].history.history.baseline.projection)).toBe(
    true,
  );
  expect(result.checkpoint.byteLength).toBe(
    new TextEncoder().encode(JSON.stringify(result.payload)).length,
  );
  expect(
    await requireSharedRecoveryRetainedCheckpoint(
      result.payload,
      result.checkpoint,
      identity,
      f.originals.payload,
      f.executions.payload,
      f.shared.payload,
    ),
  ).toEqual(result.payload);
  const shuffled = clone(f.options());
  shuffled.effectSets.reverse();
  expect((await describeSharedRecoveryRetainedHistory(shuffled)).checkpoint).toEqual(
    result.checkpoint,
  );
  expect(parseSharedRecoveryRetainedCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
});

it.each([
  "duplicate",
  "unselected",
  "missing",
  "missing-selected",
  "foreign-root",
  "source",
  "provenance",
  "baseline",
  "row-count",
  "execution-count",
  "ordinal",
  "local-table",
  "before-image",
])("refuses malformed retained %s", async (change) => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    payload = clone(result.payload);
  if (change === "duplicate") payload.effectSets.push(payload.effectSets[0]);
  if (change === "unselected") payload.effectSets.push({ ...payload.effectSets[0], id: "other" });
  if (change === "missing") payload.effectSets.pop();
  if (change === "missing-selected") {
    payload.effectSets.pop();
    payload.selection.effectSets.pop();
  }
  if (change === "foreign-root") payload.selection.effectSets[0].rootId = "other-root";
  if (change === "source") payload.selection.effectSets[0].source = "unknown";
  if (change === "provenance") payload.effectSets[0].source = "rebase";
  if (change === "baseline") payload.selection.effectSets[0].baselineId = "other";
  if (change === "row-count") payload.selection.effectSets[0].effectCount++;
  if (change === "execution-count") payload.selection.effectSets[0].executionCount--;
  if (change === "ordinal") payload.effectSets[0].history.history.effectSets[0].effects[0].ord = 1;
  if (change === "local-table")
    payload.effectSets[0].history.history.effectSets[0].effects[0].table = "taskspace_local";
  if (change === "before-image")
    payload.effectSets[0].history.history.effectSets[0].effects[0].before.name = ["text", "other"];
  expect(() => parseSharedRecoveryRetainedHistory(payload)).toThrow();
});

it.each(["source", "truncated-origin", "child-input", "unused-binding"])(
  "requires the original trusted inventory and contents after %s changes",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryRetainedHistory(f.options()),
      payload = clone(result.payload);
    if (change === "source") {
      payload.selection.effectSets[0].source = "rebase";
      payload.effectSets[0].source = "rebase";
    }
    if (change === "truncated-origin") {
      payload.selection.effectSets.shift();
      payload.effectSets.shift();
    }
    if (change === "child-input")
      payload.effectSets[2].executions.effectSets[0].executions[1].input.ref = reference(12);
    if (change === "unused-binding")
      payload.effectSets[2].executions.effectSets[0].generated.unused.value = "changed";
    if (change !== "unused-binding")
      expect(() => parseSharedRecoveryRetainedHistory(payload)).not.toThrow();
    await expect(
      requireSharedRecoveryRetainedCheckpoint(
        payload,
        result.checkpoint,
        identity,
        f.originals.payload,
        f.executions.payload,
        f.shared.payload,
      ),
    ).rejects.toThrow();
  },
);

it.each([
  "selected-context",
  "selected-rows",
  "selected-input",
  "original-root",
  "original-parent",
  "source-hash",
])("refuses %s drift even if individual run structure is valid", async (change) => {
  const f = await fixture(),
    options = clone(f.options());
  const selected = options.effectSets[1],
    archived = options.effectSets[2];
  if (change === "selected-context") {
    selected.history.history.baseline.projection.tables.find(
      (table: { name: string }) => table.name === "namespace",
    ).rows[0].name = ["text", reference(12)];
    selected.history.history.effectSets[0].effects[0].before.name = ["text", reference(12)];
  }
  if (change === "selected-rows") {
    selected.history.history.effectSets[0].effects[0].after.name = ["text", reference(12)];
    selected.history.history.effectSets[0].effects[1].before.name = ["text", reference(12)];
  }
  if (change === "selected-input") {
    selected.executions.effectSets[0].invocation.input.ref = reference(12);
    selected.executions.effectSets[0].executions[0].input.ref = reference(12);
  }
  if (change === "original-root") {
    archived.executions.effectSets[0].invocation.input.ref = reference(12);
    archived.executions.effectSets[0].executions[0].input.ref = reference(12);
  }
  if (change === "original-parent")
    archived.executions.effectSets[0].executions[1].kind = "future.other";
  if (change === "source-hash") archived.executions.checkpoint.sha256 = "b".repeat(64);
  if (change === "selected-context" || change === "selected-rows") await redescribeSet(selected);
  await expect(describeSharedRecoveryRetainedHistory(options)).rejects.toThrow();
});

it("checks a nested source hash even when the outer descriptor is deliberately recomputed to match", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    payload = clone(result.payload);
  payload.effectSets[0].executions.checkpoint.sha256 = "b".repeat(64);
  const bytes = new TextEncoder().encode(JSON.stringify(payload)),
    digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const checkpoint = {
    ...result.checkpoint,
    byteLength: bytes.length,
    sha256: Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
  };
  await expect(
    requireSharedRecoveryRetainedCheckpoint(
      payload,
      checkpoint,
      identity,
      f.originals.payload,
      f.executions.payload,
      f.shared.payload,
    ),
  ).rejects.toThrow("content mismatch");
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires the host %s before hashing",
  async (field) => {
    const f = await fixture(),
      result = await describeSharedRecoveryRetainedHistory(f.options()),
      digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      requireSharedRecoveryRetainedCheckpoint(
        result.payload,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        f.originals.payload,
        f.executions.payload,
        f.shared.payload,
      ),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);

it.each(["description", "verification"])(
  "owns every retained and current source before hashing during %s",
  async (mode) => {
    const f = await fixture(),
      expected = await describeSharedRecoveryRetainedHistory(f.options()),
      options = clone(f.options()),
      payload = clone(expected.payload),
      checkpoint = clone(expected.checkpoint),
      wantedIdentity = { ...identity };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      options.effectSets.length = 0;
      options.selection.effectSets.length = 0;
      options.originals.actions.length = 0;
      options.executions.effectSets.length = 0;
      options.sharedHistory.history.effectSets.length = 0;
      payload.effectSets.length = 0;
      checkpoint.sha256 = "b".repeat(64);
      wantedIdentity.deviceId = "changed";
      return digest(...args);
    });
    const actual =
      mode === "description"
        ? (await describeSharedRecoveryRetainedHistory(options)).payload
        : await requireSharedRecoveryRetainedCheckpoint(
            payload,
            checkpoint,
            wantedIdentity,
            options.originals,
            options.executions,
            options.sharedHistory,
          );
    expect(actual).toEqual(expected.payload);
  },
);

it.each(["getter", "array-getter", "extra-field", "version", "duplicate-selection"])(
  "refuses %s retained transport without invoking hooks",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryRetainedHistory(f.options()),
      payload = clone(result.payload),
      invoked = vi.fn();
    if (change === "getter")
      Object.defineProperty(payload.effectSets[0], "history", { enumerable: true, get: invoked });
    if (change === "array-getter")
      Object.defineProperty(payload.effectSets, "0", { enumerable: true, get: invoked });
    if (change === "extra-field") payload.effectSets[0].extra = true;
    if (change === "version") payload.version++;
    if (change === "duplicate-selection")
      payload.selection.effectSets.push(payload.selection.effectSets[0]);
    expect(() => parseSharedRecoveryRetainedHistory(payload)).toThrow();
    expect(invoked).not.toHaveBeenCalled();
  },
);

it.each(["version", "hash", "hash-newline", "length", "missing-selected", "root"])(
  "refuses malformed retained descriptor %s",
  async (change) => {
    const f = await fixture(),
      result = await describeSharedRecoveryRetainedHistory(f.options()),
      checkpoint = clone(result.checkpoint);
    if (change === "version") checkpoint.version++;
    if (change === "hash") checkpoint.sha256 = "A".repeat(64);
    if (change === "hash-newline") checkpoint.sha256 += "\n";
    if (change === "length") checkpoint.byteLength = 0;
    if (change === "missing-selected") checkpoint.selection.effectSets.pop();
    if (change === "root") checkpoint.selection.effectSets[0].rootId = "unselected";
    expect(() => parseSharedRecoveryRetainedCheckpoint(checkpoint)).toThrow();
  },
);

it("inspects historical descriptors without accepting old-schema contexts", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    old = clone(result.checkpoint);
  old.checkpoint.checkpoint.checkpoint.identity.schemaId = migrations.at(-2)!.id;
  expect(parseSharedRecoveryRetainedCheckpoint(old)).toEqual(old);
  expect(() =>
    parseSharedRecoveryRetainedHistory({ ...result.payload, checkpoint: old.checkpoint }),
  ).toThrow("Unsupported");
});

it("checks every retained before and after SQL state in isolated databases and rolls all temporary rows back", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    targets: Awaited<ReturnType<typeof createTestDB>>[] = [];
  const create = async () => {
    const target = await createTestDB();
    targets.push(target);
    return target;
  };
  expect(
    await validateSharedRecoveryRetainedHistory(
      create,
      result.payload,
      result.checkpoint,
      identity,
      f.originals.payload,
      f.executions.payload,
      f.shared.payload,
    ),
  ).toEqual(result.payload);
  expect(targets).toHaveLength(8);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM local_recovery_actions`)).toEqual([]);
  }
});

it("refuses altered trusted content before allocating validation SQL", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    create = vi.fn(createTestDB);
  await expect(
    validateSharedRecoveryRetainedHistory(
      create,
      result.payload,
      { ...result.checkpoint, sha256: "b".repeat(64) },
      identity,
      f.originals.payload,
      f.executions.payload,
      f.shared.payload,
    ),
  ).rejects.toThrow("content mismatch");
  expect(create).not.toHaveBeenCalled();
});

it.each(["before-affinity", "after-foreign-key"])(
  "refuses retained %s SQL states despite matching canonical hashes",
  async (change) => {
    const f = await fixture(),
      options = clone(f.options()),
      archived = options.effectSets[2];
    if (change === "before-affinity")
      archived.history.history.baseline.projection.tables
        .find((table: { name: string }) => table.name === "warp")
        .rows.push({
          id: ["text", "w"],
          namespace_id: ["text", "n"],
          pos_x: ["integer", "0"],
          pos_y: ["real", "3ff0000000000000"],
        });
    else {
      archived.history.history.effectSets[0].effects.push({
        ord: 2,
        table: "warp",
        key: { id: ["text", "w"] },
        op: "I",
        before: null,
        after: {
          id: ["text", "w"],
          namespace_id: ["text", "missing"],
          pos_x: ["integer", "0"],
          pos_y: ["integer", "0"],
        },
      });
      archived.history.selection.effectSets[0].effectCount++;
      archived.executions.effectSets[0].effects.push({ ord: 2, actionId: "root", executionOrd: 0 });
      options.selection.effectSets[2].effectCount++;
    }
    await redescribeSet(archived);
    const result = await describeSharedRecoveryRetainedHistory(options),
      targets: Awaited<ReturnType<typeof createTestDB>>[] = [];
    await expect(
      validateSharedRecoveryRetainedHistory(
        async () => {
          const target = await createTestDB();
          targets.push(target);
          return target;
        },
        result.payload,
        result.checkpoint,
        identity,
        f.originals.payload,
        f.executions.payload,
        f.shared.payload,
      ),
    ).rejects.toThrow();
    expect(targets).toHaveLength(change === "before-affinity" ? 5 : 6);
    for (const target of targets) {
      expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
      expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
    }
  },
);

it("refuses success after an isolated endpoint validation commit fails", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    target = await createTestDB();
  const wrapped = createDatabaseAdapter(new Proxy(target, {}), {
    read: (work) => withReadTx(target, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(target, async (tx) => {
        const result = await work(tx);
        await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
        await tx.run(
          sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
        );
        await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
        return result;
      }),
  });
  const create = vi.fn(async () => wrapped);
  await expect(
    validateSharedRecoveryRetainedHistory(
      create,
      result.payload,
      result.checkpoint,
      identity,
      f.originals.payload,
      f.executions.payload,
      f.shared.payload,
    ),
  ).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(1);
  expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});

it("requires per-run baseline, row and invocation images while preserving extra entries", async () => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    images = clone(f.images);
  images.effectSets[0].history.baseline.manifest = manifest(0, 12);
  expect(sharedRecoveryRetainedAssetManifest(result.payload, images)).toEqual(
    manifest(0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12),
  );
});
it.each([
  "origin-before",
  "superseded-middle",
  "superseded-child",
  "skipped-child",
  "missing-run",
  "order",
  "conflict",
])("refuses retained image %s gaps even if another manifest has the entry", async (change) => {
  const f = await fixture(),
    result = await describeSharedRecoveryRetainedHistory(f.options()),
    images = clone(f.images);
  const remove = (index: number, n: number) => {
    images.effectSets[index].history.effectSets[0].manifest.entries = images.effectSets[
      index
    ].history.effectSets[0].manifest.entries.filter(
      (entry: { name: string }) => entry.name !== manifest(n).entries[0].name,
    );
  };
  if (change === "origin-before") images.effectSets[0].history.baseline.manifest = manifest();
  if (change === "superseded-middle") {
    remove(2, 10);
    images.effectSets[0].history.baseline.manifest = manifest(0, 10);
  }
  if (change === "superseded-child") {
    remove(2, 11);
    images.effectSets[0].history.baseline.manifest = manifest(0, 11);
  }
  if (change === "skipped-child") {
    remove(0, 8);
    images.effectSets[2].history.baseline.manifest = manifest(8, 9);
  }
  if (change === "missing-run") images.effectSets.pop();
  if (change === "order") images.effectSets.reverse();
  if (change === "conflict")
    images.effectSets[0].history.baseline.manifest.entries[0].sha256 = "b".repeat(64);
  expect(() => sharedRecoveryRetainedAssetManifest(result.payload, images)).toThrow();
});

it("validates a baseline-only checkpoint with no retained runs", async () => {
  const shared = await describeSharedRecoveryHistory(
    { baseline: { id: "baseline", projection: projection() }, effectSets: [] },
    identity,
    { baselineId: "baseline", effectSets: [] },
  );
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: { baselineId: "baseline", effectSets: [] },
    effectSets: [],
  });
  const originals = await describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    selection: { actionIds: [] },
    actions: [],
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
  const result = await describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    selection: { effectSets: [] },
    effectSets: [],
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
  const create = vi.fn(async () => createTestDB());
  expect(
    await validateSharedRecoveryRetainedHistory(
      create,
      result.payload,
      result.checkpoint,
      identity,
      originals.payload,
      executions.payload,
      shared.payload,
    ),
  ).toEqual(result.payload);
  expect(create).toHaveBeenCalledTimes(1);
  expect(sharedRecoveryRetainedAssetManifest(result.payload, { effectSets: [] })).toEqual(
    manifest(),
  );
});
