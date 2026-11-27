import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import * as sharedLoader from "./shared-recovery-payload.js";
import * as actionLoader from "./shared-recovery-action-payload.js";
import * as executionLoader from "./shared-recovery-execution-payload.js";
import {
  saveRegisteredSharedRecoveryRetainedPayload,
  loadRegisteredSharedRecoveryRetainedPayload,
  inspectRegisteredSharedRecoveryRetainedPayload,
} from "./shared-recovery-retained-payload.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
}));
vi.mock("./shared-recovery-action-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-action-payload.js")>()),
}));
vi.mock("./shared-recovery-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-payload.js")>()),
}));
vi.mock("./shared-recovery-execution-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-execution-payload.js")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof recovery.captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof recovery.describeSharedRecoveryHistory>>;
let executions: Awaited<ReturnType<typeof recovery.describeSharedRecoveryExecutions>>;
let retained: Awaited<ReturnType<typeof recovery.describeSharedRecoveryRetainedHistory>>;
let originals: Awaited<ReturnType<typeof recovery.describeSharedRecoveryActions>>;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const factory = () => createTestDB();
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const reference = (n: number) => `kozane-image:/api/images/${filename(n)}`;
const row = (n: number) => ({
  id: ["text", "n"] as const,
  name: ["text", reference(n)] as const,
  is_default: ["integer", "0"] as const,
});
const directory = () => join(root, ".kozane", "recovery", "retained-history");
const published = () => join(directory(), `${retained.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${retained.checkpoint.sha256}.json`);
type Source = "local" | "shared" | "executions" | "actions";
const sourceNames = ["local", "shared", "executions", "actions"] as const;
const sourceDescriptor = (source: Source) =>
  source === "local"
    ? local.checkpoint
    : source === "shared"
      ? shared.checkpoint
      : source === "executions"
        ? executions.checkpoint
        : originals.checkpoint;
const sourceDirectory = (source: Source) =>
  join(
    root,
    ".kozane",
    "recovery",
    source === "local"
      ? "checkpoints"
      : source === "shared"
        ? "shared-history"
        : source === "executions"
          ? "executions"
          : "actions",
  );
const sourcePath = (source: Source) =>
  join(sourceDirectory(source), `${sourceDescriptor(source).sha256}.json`);
const sourceTemporary = (source: Source) =>
  join(sourceDirectory(source), `.pending-${sourceDescriptor(source).sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(retained.payload), "utf8");
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  executionMaxBytes: executions.checkpoint.byteLength,
  actionMaxBytes: originals.checkpoint.byteLength,
  maxBytes: retained?.checkpoint.byteLength ?? 1,
  createValidationDatabase: factory,
});
const save = () =>
  saveRegisteredSharedRecoveryRetainedPayload({ ...options(), input: retained.payload });
const load = () => loadRegisteredSharedRecoveryRetainedPayload(options());
const inspect = () => inspectRegisteredSharedRecoveryRetainedPayload(root, db, key);
const catalog = async () => ({
  retained: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
  ),
  actions: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
  ),
  local: await db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
  ),
  shared: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
  ),
  executions: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
  ),
});
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-retained-payload-"));
  db = await createTestDB(join(root, "db.sqlite"));
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','device-only','workspace_relative',9007199254740993)`,
  );
  local = await recovery.captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  shared = await recovery.describeSharedRecoveryHistory(
    {
      baseline: {
        id: "baseline",
        projection: {
          version: 1,
          rowEncodingVersion: 1,
          schemaId: identity.schemaId,
          tables: [
            "namespace",
            "partition",
            "layer",
            "scope",
            "taskspace",
            "inventory",
            "card",
            "glue",
            "glue_rel",
            "scope_rel",
            "scope_area",
            "warp",
          ].map((name) => ({ name, rows: [] })),
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
  await recovery.rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  const invocation = {
    id: "root",
    kind: "future.root",
    contractVersion: 99,
    input: { ref: reference(0), text: '\ufeff{"text":"exact"}\0🪁' },
  };
  const child = {
    id: "child",
    kind: "future.child",
    contractVersion: 99,
    input: { ref: reference(3) },
  };
  const empty = {
    id: "empty-root",
    kind: "future.noop",
    contractVersion: 99,
    input: { ref: reference(4) },
  };
  const generated = {
    child: { type: "child-id", value: "child" },
    unused: { type: "entity-id", value: "unused" },
    skipped: { type: "child-id", value: "skipped" },
  };
  executions = await recovery.describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", rootId: "root", executionCount: 2 },
        { id: "empty", rootId: "empty-root", executionCount: 1 },
      ],
    },
    effectSets: [
      {
        id: "edit",
        invocation,
        generated,
        executions: [
          { ...invocation, parentId: null, executionOrd: 0, generated: { child: generated.child } },
          { ...child, parentId: "root", executionOrd: 1, generated: {} },
        ],
        effects: [
          { ord: 0, actionId: "root", executionOrd: 0 },
          { ord: 1, actionId: "child", executionOrd: 1 },
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
    ],
  });
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  const provenance = {
    deviceId: "first-record-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
    hlc: "opaque:first-record",
  };
  originals = await recovery.describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: { actionIds: ["root", "child", "skipped", "empty-root"] },
    actions: [
      { ...invocation, rootId: "root", parentId: null, generated, seq: "1", ...provenance },
      {
        ...child,
        rootId: "root",
        parentId: "root",
        generated: {},
        input: { ref: reference(5) },
        seq: "2",
        ...provenance,
      },
      {
        id: "skipped",
        rootId: "root",
        parentId: "root",
        kind: "future.skipped",
        contractVersion: 99,
        input: { ref: reference(6) },
        generated: {},
        seq: "9007199254740993",
        ...provenance,
      },
      {
        ...empty,
        rootId: "empty-root",
        parentId: null,
        generated: {},
        seq: "9223372036854775807",
        ...provenance,
      },
    ],
  });
  await recovery.rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  retained = await prepareRetained();
  await recovery.rememberSharedRecoveryRetainedCheckpoint(db, retained.checkpoint);
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
  await executionLoader.saveRegisteredSharedRecoveryExecutionPayload({
    ...options(),
    input: executions.payload,
  });
  await actionLoader.saveRegisteredSharedRecoveryActionPayload({
    ...options(),
    input: originals.payload,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
async function prepareRetained() {
  const sets: recovery.SharedRecoveryRetainedSet[] = [];
  const inventory: recovery.SharedRecoveryRetainedSelection["effectSets"][number][] = [];
  const context = (n?: number) => ({
    ...shared.payload.history.baseline.projection,
    tables: shared.payload.history.baseline.projection.tables.map(({ name }) => ({
      name,
      rows: name === "namespace" && n !== undefined ? [row(n)] : [],
    })),
  });
  const changed = (from: number, to: number) => [
    {
      ord: 0,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "U",
      before: row(from),
      after: row(to),
    },
    {
      ord: 1,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "D",
      before: row(to),
      after: null,
    },
  ];
  for (const [id, source, before] of [
    ["origin", "origin", 7],
    ["empty", "authoritative", undefined],
    ["superseded", "rebase", 9],
    ["edit", "rebase", undefined],
  ] as const) {
    const current = id === "empty" ? 1 : 0;
    const group = clone(executions.payload.effectSets[current]);
    group.id = id;
    if (before !== undefined) {
      group.effects = [
        { ord: 0, actionId: "child", executionOrd: 1 },
        { ord: 1, actionId: "root", executionOrd: 0 },
      ];
      group.executions[1].input = { ref: reference(id === "origin" ? 5 : 11) };
      if (id === "origin") {
        group.executions[0].generated.skipped = group.generated.skipped;
        group.executions.push({
          id: "skipped",
          parentId: "root",
          kind: "future.skipped",
          contractVersion: 99,
          executionOrd: 2,
          input: { ref: reference(6) },
          generated: {},
        });
      }
    }
    const effects =
      before === undefined
        ? shared.payload.history.effectSets[current].effects
        : changed(before, before + 1);
    const history = await recovery.describeSharedRecoveryHistory(
      {
        baseline: { id: `before-${id}`, projection: context(before) },
        effectSets: [{ id, effects }],
      },
      identity,
      { baselineId: `before-${id}`, effectSets: [{ id, effectCount: effects.length }] },
    );
    const execution = await recovery.describeSharedRecoveryExecutions({
      checkpoint: history.checkpoint,
      sharedHistory: history.payload,
      selection: {
        baselineId: `before-${id}`,
        effectSets: [{ id, rootId: group.invocation.id, executionCount: group.executions.length }],
      },
      effectSets: [group],
    });
    sets.push({
      id,
      rootId: group.invocation.id,
      source,
      history: history.payload,
      executions: execution.payload,
    });
    inventory.push({
      id,
      rootId: group.invocation.id,
      source,
      baselineId: `before-${id}`,
      effectCount: effects.length,
      executionCount: group.executions.length,
    });
  }
  return recovery.describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    selection: { effectSets: inventory },
    effectSets: sets,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
}

it("publishes complete retained runs after all five expectations commit and preserves source bytes", async () => {
  const before = await catalog(),
    sourceBytes = await Promise.all(sourceNames.map((source) => fs.readFile(sourcePath(source))));
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      for (const [table, descriptor] of [
        ["local_recovery_retained_history", retained.checkpoint],
        ["local_recovery_actions", originals.checkpoint],
        ["local_recovery_executions", executions.checkpoint],
        ["local_recovery_shared_history", shared.checkpoint],
        ["local_recovery_checkpoint", local.checkpoint],
      ] as const)
        expect(reader.prepare(`SELECT descriptor FROM ${table}`).get()?.descriptor).toBe(
          JSON.stringify(descriptor),
        );
    } finally {
      reader.close();
    }
    expect(await fs.readFile(String(from))).toEqual(bytes());
    expect(existsSync(String(to))).toBe(false);
    return link(from, to);
  });
  expect(await save()).toEqual({
    path: published(),
    binding: { checkpoint: retained.checkpoint, localCheckpoint: local.checkpoint },
    changed: true,
  });
  expect(await fs.readFile(published())).toEqual(bytes());
  expect(existsSync(temporary())).toBe(false);
  if (process.platform !== "win32") expect((await fs.stat(published())).mode & 0o777).toBe(0o600);
  const stat = await fs.stat(published(), { bigint: true });
  expect((await save()).changed).toBe(false);
  expect(await fs.stat(published(), { bigint: true })).toMatchObject({
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
  });
  expect(await Promise.all(sourceNames.map((source) => fs.readFile(sourcePath(source))))).toEqual(
    sourceBytes,
  );
  expect(await catalog()).toEqual(before);
  expect(existsSync(join(root, ".kozane", "assets"))).toBe(false);
});

it("reopens independent origin and superseded contexts, selected runs and skipped executions without writes or live installation", async () => {
  await save();
  const before = await catalog(),
    reopened = await openDb(`file:${join(root, "db.sqlite")}`),
    targets: Awaited<ReturnType<typeof factory>>[] = [];
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredSharedRecoveryRetainedPayload({
      ...options(),
      db: reopened.db,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    });
    expect(result).toEqual({
      payload: retained.payload,
      binding: { checkpoint: retained.checkpoint, localCheckpoint: local.checkpoint },
    });
    expect(result.payload.effectSets.map(({ id }) => id)).toEqual([
      "origin",
      "empty",
      "superseded",
      "edit",
    ]);
    expect(result.payload.effectSets[0].executions.effectSets[0].executions[2].id).toBe("skipped");
    expect(result.payload.effectSets[2].executions.effectSets[0].executions[1].input).toEqual({
      ref: reference(11),
    });
    expect(result.payload.effectSets[0].executions.effectSets[0].invocation.input).toEqual(
      executions.payload.effectSets[0].invocation.input,
    );
    expect(result.payload.effectSets[0].executions.effectSets[0].invocation.contractVersion).toBe(
      99,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.effectSets[0].history.history.baseline.projection)).toBe(
      true,
    );
  } finally {
    reopened.close();
  }
  // Six source SQL checks and two independent endpoints for each of the four retained runs.
  expect(targets).toHaveLength(14);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
  }
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" && (call[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
  expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
  expect(await catalog()).toEqual(before);
});

it("inspects orphaned evidence without creating paths or authorizing loading", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_actions`);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(save()).rejects.toThrow();
  await expect(load()).rejects.toThrow();
  expect(await fs.readFile(published())).toEqual(bytes());
});

it.each([
  "maxBytes",
  "localMaxBytes",
  "sharedMaxBytes",
  "executionMaxBytes",
  "actionMaxBytes",
] as const)("enforces independent %s before file reads or SQL allocation", async (field) => {
  await save();
  const input = options();
  input[field]--;
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  await expect(
    loadRegisteredSharedRecoveryRetainedPayload({ ...input, createValidationDatabase: create }),
  ).rejects.toThrow("exceeds read limit");
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid byte limit %s before reads",
  async (limit) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    for (const field of [
      "maxBytes",
      "localMaxBytes",
      "sharedMaxBytes",
      "executionMaxBytes",
      "actionMaxBytes",
    ])
      await expect(
        loadRegisteredSharedRecoveryRetainedPayload({
          ...options(),
          [field]: limit,
          createValidationDatabase: create,
        }),
      ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it("requires full host identity before file reads", async () => {
  await save();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  for (const field of ["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)
    await expect(
      loadRegisteredSharedRecoveryRetainedPayload({
        ...options(),
        expected: { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([
  "local_recovery_retained_history",
  "local_recovery_actions",
  "local_recovery_executions",
  "local_recovery_shared_history",
  "local_recovery_checkpoint",
])("requires %s before opening payloads", async (table) => {
  await save();
  await db.run(sql.raw(`DELETE FROM ${table}`));
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  await expect(
    loadRegisteredSharedRecoveryRetainedPayload({ ...options(), createValidationDatabase: create }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each(["source", "truncation", "intermediate", "context", "input", "unused-binding"])(
  "refuses changed retained %s before source SQL allocation",
  async (change) => {
    const input = clone(retained.payload);
    if (change === "source") {
      input.effectSets[0].source = "rebase";
      input.selection.effectSets[0].source = "rebase";
    }
    if (change === "truncation") {
      input.effectSets.shift();
      input.selection.effectSets.shift();
    }
    if (change === "intermediate") {
      input.effectSets[2].history.history.effectSets[0].effects[0].after.name = [
        "text",
        reference(12),
      ];
      input.effectSets[2].history.history.effectSets[0].effects[1].before.name = [
        "text",
        reference(12),
      ];
    }
    if (change === "context") {
      input.effectSets[2].history.history.baseline.projection.tables.find(
        (t: { name: string }) => t.name === "namespace",
      ).rows[0].name = ["text", reference(12)];
      input.effectSets[2].history.history.effectSets[0].effects[0].before.name = [
        "text",
        reference(12),
      ];
    }
    if (change === "input")
      input.effectSets[2].executions.effectSets[0].executions[1].input.ref = reference(12);
    if (change === "unused-binding")
      input.effectSets[2].executions.effectSets[0].generated.unused.value = "changed";
    const create = vi.fn(factory);
    await expect(
      saveRegisteredSharedRecoveryRetainedPayload({
        ...options(),
        input,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(directory())).toBe(false);
  },
);

it.each(sourceNames)(
  "requires the saved %s source and preserves its temporary evidence",
  async (source) => {
    await fs.rename(sourcePath(source), sourceTemporary(source));
    const before = await fs.readFile(sourceTemporary(source));
    await expect(save()).rejects.toThrow();
    expect(existsSync(directory())).toBe(false);
    expect(await fs.readFile(sourceTemporary(source))).toEqual(before);
  },
);

it.each(["save", "load"])(
  "owns the payload, identity, path and limits during %s callbacks",
  async (mode) => {
    if (mode === "load") await save();
    const input = { ...options(), input: clone(retained.payload), expected: { ...identity } };
    input.createValidationDatabase = async () => {
      input.input.effectSets.length = 0;
      input.expected.deviceId = "changed";
      input.root = join(root, "elsewhere");
      input.localMaxBytes = 0;
      input.sharedMaxBytes = 0;
      input.executionMaxBytes = 0;
      input.actionMaxBytes = 0;
      input.maxBytes = 0;
      return factory();
    };
    if (mode === "save") await saveRegisteredSharedRecoveryRetainedPayload(input);
    else
      expect((await loadRegisteredSharedRecoveryRetainedPayload(input)).payload).toEqual(
        retained.payload,
      );
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it.each(["save", "load"])(
  "preserves prior evidence after the final %s commit fails",
  async (mode) => {
    if (mode === "load") await save();
    let ready = false;
    const validate = recovery.validateSharedRecoveryRetainedHistory;
    vi.spyOn(recovery, "validateSharedRecoveryRetainedHistory").mockImplementationOnce(
      async (...args) => {
        const result = await validate(...args);
        ready = true;
        return result;
      },
    );
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(db, async (tx) => {
          const result = await work(tx);
          if (ready) {
            await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
            await tx.run(
              sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
            );
            await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
          }
          return result;
        }),
    });
    const before = await catalog();
    await expect(
      mode === "save"
        ? saveRegisteredSharedRecoveryRetainedPayload({
            ...options(),
            input: retained.payload,
            db: wrapped,
          })
        : loadRegisteredSharedRecoveryRetainedPayload({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);

it("refuses coherent replacement of all five bindings after retained SQL validation", async () => {
  const validate = recovery.validateSharedRecoveryRetainedHistory;
  vi.spyOn(recovery, "validateSharedRecoveryRetainedHistory").mockImplementationOnce(
    async (...args) => {
      const result = await validate(...args),
        nextLocal = { ...local.checkpoint, sha256: "b".repeat(64) },
        nextShared = { ...shared.checkpoint, sha256: "c".repeat(64) },
        nextExecution = {
          ...executions.checkpoint,
          checkpoint: nextShared,
          sha256: "d".repeat(64),
        },
        nextOriginal = { ...originals.checkpoint, checkpoint: nextExecution },
        nextRetained = { ...retained.checkpoint, checkpoint: nextOriginal };
      await withTx(db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
        );
        for (const [table, descriptor] of [
          ["local_recovery_shared_history", nextShared],
          ["local_recovery_executions", nextExecution],
          ["local_recovery_actions", nextOriginal],
          ["local_recovery_retained_history", nextRetained],
        ] as const)
          await tx.run(
            sql`UPDATE ${sql.raw(table)} SET descriptor=${JSON.stringify(descriptor)},local_descriptor=${JSON.stringify(nextLocal)}`,
          );
      });
      return result;
    },
  );
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});

async function changeRetainedSet(index: number, change: (set: any) => void) {
  const payload = clone(retained.payload),
    set = payload.effectSets[index];
  change(set);
  const history = await recovery.describeSharedRecoveryHistory(
    set.history.history,
    identity,
    set.history.selection,
  );
  set.history = history.payload;
  const execution = await recovery.describeSharedRecoveryExecutions({
    checkpoint: history.checkpoint,
    sharedHistory: history.payload,
    selection: set.executions.selection,
    effectSets: set.executions.effectSets,
  });
  set.executions = execution.payload;
  payload.selection.effectSets[index].effectCount =
    history.payload.selection.effectSets[0].effectCount;
  retained = await recovery.describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    selection: payload.selection,
    effectSets: payload.effectSets,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
  await db.run(
    sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify(retained.checkpoint)}`,
  );
}

it.each(["before-affinity", "after-foreign-key"])(
  "validates deselected %s SQL states even when every canonical hash matches",
  async (defect) => {
    await changeRetainedSet(2, (set) => {
      const warp = {
        id: ["text", "w"],
        namespace_id: ["text", defect === "before-affinity" ? "n" : "missing"],
        pos_x: ["integer", "0"],
        pos_y: defect === "before-affinity" ? ["real", "3ff0000000000000"] : ["integer", "0"],
      };
      if (defect === "before-affinity")
        set.history.history.baseline.projection.tables
          .find((table: { name: string }) => table.name === "warp")
          .rows.push(warp);
      else {
        set.history.history.effectSets[0].effects.push({
          ord: 2,
          table: "warp",
          key: { id: ["text", "w"] },
          op: "I",
          before: null,
          after: warp,
        });
        set.history.selection.effectSets[0].effectCount++;
        set.executions.effectSets[0].effects.push({ ord: 2, actionId: "root", executionOrd: 0 });
      }
    });
    for (const operation of ["save", "load"] as const) {
      if (operation === "load") {
        await fs.mkdir(directory(), { recursive: true });
        await fs.writeFile(published(), bytes());
      }
      const targets: Awaited<ReturnType<typeof factory>>[] = [];
      const input = {
        ...options(),
        createValidationDatabase: async () => {
          const target = await factory();
          targets.push(target);
          return target;
        },
      };
      await expect(
        operation === "save"
          ? saveRegisteredSharedRecoveryRetainedPayload({ ...input, input: retained.payload })
          : loadRegisteredSharedRecoveryRetainedPayload(input),
      ).rejects.toThrow();
      expect(targets).toHaveLength(defect === "before-affinity" ? 11 : 12);
      for (const target of targets) {
        expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
        expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
        expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
      }
      if (operation === "save") expect(existsSync(directory())).toBe(false);
      else expect(await fs.readFile(published())).toEqual(bytes());
    }
  },
);

it("saves and reopens a superseded child input larger than the fixed verification buffer", async () => {
  await changeRetainedSet(2, (set) => {
    set.executions.effectSets[0].executions[1].input.text = "🪁".repeat(20000);
  });
  expect(retained.checkpoint.byteLength).toBeGreaterThan(65536);
  expect((await save()).changed).toBe(true);
  expect((await load()).payload).toEqual(retained.payload);
});

it("serializes all five catalog removals across retained publication", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>(),
    link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return link(...args);
  });
  const saving = save();
  try {
    await entered.promise;
    for (const table of [
      "local_recovery_retained_history",
      "local_recovery_actions",
      "local_recovery_executions",
      "local_recovery_shared_history",
      "local_recovery_checkpoint",
    ]) {
      await other.db.values(sql`PRAGMA busy_timeout=1`);
      await expect(
        withTx(other.db, (tx) => tx.run(sql.raw(`DELETE FROM ${table}`))),
      ).rejects.toThrow();
    }
    proceed.resolve();
    await saving;
  } finally {
    proceed.resolve();
    await saving.catch(() => undefined);
    other.close();
  }
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
});

it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary retained evidence",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), temporary());
    } else
      await fs.writeFile(temporary(), state === "matching" ? bytes() : Buffer.from("{partial"));
    const link = vi.spyOn(fs, "link"),
      unlink = vi.spyOn(fs, "unlink");
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(await inspect()).toMatchObject({
      published: "absent",
      temporary:
        state === "matching"
          ? "matching-content"
          : state === "symlink"
            ? "unsafe-path"
            : "different-content",
    });
  },
);
it.each(["different", "directory", "symlink"])(
  "refuses an existing %s final path without replacement",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "directory") await fs.mkdir(published());
    if (state === "different") await fs.writeFile(published(), "different");
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), published());
    }
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(existsSync(temporary())).toBe(false);
    expect(await inspect()).toMatchObject({
      published: state === "symlink" ? "unsafe-path" : "different-content",
      temporary: "absent",
    });
  },
);
it("refuses a symlinked retained directory without writing its target", async () => {
  await fs.mkdir(join(root, "outside"));
  await fs.symlink(join(root, "outside"), directory());
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await fs.readdir(join(root, "outside"))).toEqual([]);
});
it.each(["link", "unlink"] as const)(
  "preserves file and catalog evidence after %s failure",
  async (failure) => {
    vi.spyOn(fs, failure).mockRejectedValueOnce(new Error("Publication failed"));
    const before = await catalog();
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: failure === "link" ? "absent" : "matching-content",
      temporary: "matching-content",
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await catalog()).toEqual(before);
  },
);
it.each(["partial-write", "file-sync", "directory-sync"])(
  "preserves retained evidence after %s failure",
  async (failure) => {
    if (failure === "directory-sync" && process.platform === "win32") return;
    const open = fs.open;
    let failed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        !failed &&
        String(args[0]) === (failure === "directory-sync" ? directory() : temporary())
      ) {
        failed = true;
        if (failure === "partial-write") {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await write(bytes().subarray(0, 10));
            throw new Error("Partial write");
          });
        } else vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("Sync failed"));
      }
      return handle;
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(failed).toBe(true);
    expect(await inspect()).toMatchObject({
      published: failure === "directory-sync" ? "matching-content" : "absent",
      temporary:
        failure === "directory-sync"
          ? "absent"
          : failure === "partial-write"
            ? "different-content"
            : "matching-content",
    });
    if (failure === "directory-sync") expect((await save()).changed).toBe(false);
  },
);
it.each(["missing", "corrupt", "symlink", "temporary"])(
  "refuses %s retained bytes before source SQL allocation",
  async (state) => {
    await save();
    if (state === "missing") await fs.unlink(published());
    if (state === "corrupt") await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    if (state === "symlink") {
      await fs.rename(published(), join(root, "outside"));
      await fs.symlink(join(root, "outside"), published());
    }
    if (state === "temporary") await fs.writeFile(temporary(), bytes());
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryRetainedPayload({
        ...options(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["utf8", "json", "noncanonical", "bom"])(
  "refuses hash-matching invalid %s retained bytes before SQL allocation",
  async (state) => {
    const content =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(retained.payload))
            : Buffer.from(JSON.stringify(retained.payload, null, 2));
    const checkpoint = {
      ...retained.checkpoint,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
    await db.run(
      sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify(checkpoint)}`,
    );
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryRetainedPayload({
        ...options(),
        maxBytes: content.length,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([
  "removed",
  "rewritten",
  "replaced",
  "new-temporary",
  "retained-binding",
  "execution-binding",
  "original-binding",
  "shared-file",
  "original-file",
  "original-temporary",
  "local-file",
  "execution-file",
  "execution-temporary",
])("refuses %s changes after saved sources and during retained SQL validation", async (change) => {
  await save();
  let calls = 0;
  await expect(
    loadRegisteredSharedRecoveryRetainedPayload({
      ...options(),
      createValidationDatabase: async () => {
        if (++calls === 7) {
          if (change === "removed") await fs.unlink(published());
          if (change === "rewritten") {
            await fs.writeFile(published(), bytes());
            await fs.utimes(published(), new Date(2000), new Date(2000));
          }
          if (change === "replaced") {
            const next = join(directory(), "next.json");
            await fs.writeFile(next, bytes());
            await fs.rename(next, published());
          }
          if (change === "new-temporary") await fs.writeFile(temporary(), bytes());
          if (change === "retained-binding")
            await db.run(
              sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify({ ...retained.checkpoint, sha256: "b".repeat(64) })}`,
            );
          if (change === "original-binding")
            await db.run(
              sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...originals.checkpoint, sha256: "b".repeat(64) })}`,
            );
          if (change === "shared-file") await fs.writeFile(sourcePath("shared"), "changed");
          if (change === "original-file") await fs.writeFile(sourcePath("actions"), "changed");
          if (change === "original-temporary")
            await fs.writeFile(sourceTemporary("actions"), "partial");
          if (change === "execution-binding")
            await db.run(
              sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...executions.checkpoint, sha256: "b".repeat(64) })}`,
            );
          if (change === "local-file") await fs.writeFile(sourcePath("local"), "changed");
          if (change === "execution-file") await fs.writeFile(sourcePath("executions"), "changed");
          if (change === "execution-temporary")
            await fs.writeFile(sourceTemporary("executions"), "partial");
        }
        return factory();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(14);
});
it.each(sourceNames)(
  "keeps published retained evidence if the %s source changes during publication",
  async (which) => {
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
      await fs.writeFile(sourcePath(which), "changed");
      return link(...args);
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  },
);
