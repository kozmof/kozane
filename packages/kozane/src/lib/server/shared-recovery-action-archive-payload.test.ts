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
  saveRegisteredSharedRecoveryActionArchivePayload,
  loadRegisteredSharedRecoveryActionArchivePayload,
  inspectRegisteredSharedRecoveryActionArchivePayload,
} from "./shared-recovery-action-archive-payload.js";
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
let archive: Awaited<ReturnType<typeof recovery.describeSharedRecoveryActionArchive>>;
let originals: Awaited<ReturnType<typeof recovery.describeSharedRecoveryActions>>;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const validationDatabases: Awaited<ReturnType<typeof openDb>>[] = [];
const factory = async () => {
  const opened = await openDb(":memory:");
  validationDatabases.push(opened);
  return opened.db;
};
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const reference = (n: number) => `kozane-image:/api/images/${filename(n)}`;
const row = (n: number) => ({
  id: ["text", "n"] as const,
  name: ["text", reference(n)] as const,
  is_default: ["integer", "0"] as const,
});
const directory = () => join(root, ".kozane", "recovery", "action-archives");
const published = () => join(directory(), `${archive.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${archive.checkpoint.sha256}.json`);
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
const bytes = () => Buffer.from(JSON.stringify(archive.payload), "utf8");
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  executionMaxBytes: executions.checkpoint.byteLength,
  actionMaxBytes: originals.checkpoint.byteLength,
  maxBytes: archive?.checkpoint.byteLength ?? 1,
  createValidationDatabase: factory,
});
const save = () =>
  saveRegisteredSharedRecoveryActionArchivePayload({ ...options(), input: archive.payload });
const load = () => loadRegisteredSharedRecoveryActionArchivePayload(options());
const inspect = () => inspectRegisteredSharedRecoveryActionArchivePayload(root, db, key);
const catalog = async () => ({
  archive: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_action_archives`,
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
  root = await fs.mkdtemp(join(tmpdir(), "kozane-archive-payload-"));
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
  archive = await prepareArchive();
  await recovery.rememberSharedRecoveryActionArchiveCheckpoint(db, archive.checkpoint);
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
  for (const opened of validationDatabases.splice(0)) opened.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
async function prepareArchive(actions?: unknown) {
  const current = originals.payload.actions;
  const provenance = {
    deviceId: "other-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
    hlc: "opaque:detached",
  };
  const generated = {
    child: { type: "child-id", value: "detached-child" },
    grand: { type: "child-id", value: "detached-grand" },
    skipped: { type: "child-id", value: "detached-skipped" },
    unused: { type: "entity-id", value: "unused" },
    clock: { type: "clock", value: -100 },
  };
  const detached = [
    {
      id: "detached",
      rootId: "detached",
      parentId: null,
      kind: "future.unselected",
      contractVersion: 77,
      input: { ref: reference(17), text: '\ufeff{"exact":true}\0🪁' },
      generated,
      seq: "3",
      ...provenance,
    },
    {
      id: "detached-child",
      rootId: "detached",
      parentId: "detached",
      kind: "future.child",
      contractVersion: 77,
      input: { ref: reference(18) },
      generated: { grand: generated.grand },
      seq: "4",
      ...provenance,
    },
    {
      id: "detached-grand",
      rootId: "detached",
      parentId: "detached-child",
      kind: "future.grand",
      contractVersion: 77,
      input: { ref: reference(19) },
      generated: {},
      seq: "5",
      ...provenance,
    },
    {
      id: "detached-skipped",
      rootId: "detached",
      parentId: "detached",
      kind: "future.skipped",
      contractVersion: 77,
      input: { ref: reference(20) },
      generated: {},
      seq: "9223372036854775806",
      ...provenance,
    },
  ];
  const records = actions ?? [
    ...current.slice(0, 2),
    ...detached.slice(0, 3),
    current[2],
    detached[3],
    current[3],
  ];
  return recovery.describeSharedRecoveryActionArchive({
    checkpoint: originals.checkpoint,
    selection: {
      rootIds: ["root", "detached", "empty-root"],
      actionIds: (records as recovery.SharedRecoveryActionRecord[]).map((a) => a.id),
    },
    actions: records,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
}

it("publishes complete broader originals after all five expectations commit and preserves source bytes", async () => {
  const before = await catalog(),
    sourceBytes = await Promise.all(sourceNames.map((source) => fs.readFile(sourcePath(source))));
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      for (const [table, descriptor] of [
        ["local_recovery_action_archives", archive.checkpoint],
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
    binding: { checkpoint: archive.checkpoint, localCheckpoint: local.checkpoint },
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

it("reopens unselected roots, nested and skipped children and exact originals without writes or live installation", async () => {
  await save();
  const before = await catalog(),
    reopened = await openDb(`file:${join(root, "db.sqlite")}`),
    targets: Awaited<ReturnType<typeof factory>>[] = [];
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredSharedRecoveryActionArchivePayload({
      ...options(),
      db: reopened.db,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    });
    expect(result).toEqual({
      payload: archive.payload,
      binding: { checkpoint: archive.checkpoint, localCheckpoint: local.checkpoint },
    });
    expect(result.payload.selection.rootIds).toEqual(["root", "detached", "empty-root"]);
    expect(result.payload.actions.map((a) => a.id)).toEqual([
      "root",
      "child",
      "detached",
      "detached-child",
      "detached-grand",
      "skipped",
      "detached-skipped",
      "empty-root",
    ]);
    expect(result.payload.actions[1].input).toEqual({ ref: reference(5) });
    expect(result.payload.actions[2].contractVersion).toBe(77);
    expect(result.payload.actions[2].input).toHaveProperty("text", '\ufeff{"exact":true}\0🪁');
    expect(result.payload.actions[5].seq).toBe("9007199254740993");
    expect(result.payload.actions[6].seq).toBe("9223372036854775806");
    expect(result.payload.actions[7].seq).toBe("9223372036854775807");
    for (const original of originals.payload.actions)
      expect(result.payload.actions.find((a) => a.id === original.id)).toEqual(original);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.actions[2].generated)).toBe(true);
  } finally {
    reopened.close();
  }
  // Original, execution and shared loaders perform six isolated source SQL checks.
  expect(targets).toHaveLength(6);
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
    loadRegisteredSharedRecoveryActionArchivePayload({
      ...input,
      createValidationDatabase: create,
    }),
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
        loadRegisteredSharedRecoveryActionArchivePayload({
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
      loadRegisteredSharedRecoveryActionArchivePayload({
        ...options(),
        expected: { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([
  "local_recovery_action_archives",
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
    loadRegisteredSharedRecoveryActionArchivePayload({
      ...options(),
      createValidationDatabase: create,
    }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([
  "source",
  "truncation",
  "inventory",
  "input",
  "current-original",
  "unused-binding",
  "sequence",
  "provenance",
])("refuses changed archive %s before source SQL allocation", async (change) => {
  const input = clone(archive.payload);
  if (change === "source") input.checkpoint.sha256 = "b".repeat(64);
  if (change === "truncation") {
    input.actions = input.actions.filter((a: { rootId: string }) => a.rootId !== "detached");
    input.selection.rootIds = input.selection.rootIds.filter((id: string) => id !== "detached");
    input.selection.actionIds = input.actions.map((a: { id: string }) => a.id);
  }
  if (change === "inventory") input.selection.actionIds.pop();
  if (change === "input") input.actions[3].input.ref = reference(12);
  if (change === "current-original") input.actions[1].input.ref = reference(12);
  if (change === "unused-binding") input.actions[2].generated.unused.value = "changed";
  if (change === "sequence") input.actions[3].seq = "6";
  if (change === "provenance") input.actions[3].hlc = "changed";
  const create = vi.fn(factory);
  await expect(
    saveRegisteredSharedRecoveryActionArchivePayload({
      ...options(),
      input,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(existsSync(directory())).toBe(false);
});

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
    const input = { ...options(), input: clone(archive.payload), expected: { ...identity } };
    input.createValidationDatabase = async () => {
      input.input.actions.length = 0;
      input.expected.deviceId = "changed";
      input.root = join(root, "elsewhere");
      input.localMaxBytes = 0;
      input.sharedMaxBytes = 0;
      input.executionMaxBytes = 0;
      input.actionMaxBytes = 0;
      input.maxBytes = 0;
      return factory();
    };
    if (mode === "save") await saveRegisteredSharedRecoveryActionArchivePayload(input);
    else
      expect((await loadRegisteredSharedRecoveryActionArchivePayload(input)).payload).toEqual(
        archive.payload,
      );
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it.each(["save", "load"])(
  "preserves prior evidence after the final %s commit fails",
  async (mode) => {
    if (mode === "load") await save();
    let ready = false;
    const validate = recovery.requireSharedRecoveryActionArchiveCheckpoint;
    vi.spyOn(recovery, "requireSharedRecoveryActionArchiveCheckpoint").mockImplementationOnce(
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
        ? saveRegisteredSharedRecoveryActionArchivePayload({
            ...options(),
            input: archive.payload,
            db: wrapped,
          })
        : loadRegisteredSharedRecoveryActionArchivePayload({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);

it("refuses coherent replacement of all five bindings after archive verification", async () => {
  const validate = recovery.requireSharedRecoveryActionArchiveCheckpoint;
  vi.spyOn(recovery, "requireSharedRecoveryActionArchiveCheckpoint").mockImplementationOnce(
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
        nextArchive = { ...archive.checkpoint, checkpoint: nextOriginal };
      await withTx(db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
        );
        for (const [table, descriptor] of [
          ["local_recovery_shared_history", nextShared],
          ["local_recovery_executions", nextExecution],
          ["local_recovery_actions", nextOriginal],
          ["local_recovery_action_archives", nextArchive],
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

it("saves and reopens a detached skipped input larger than the verification buffer", async () => {
  const records = clone(archive.payload.actions);
  records.find((a: { id: string }) => a.id === "detached-skipped").input.text = "🪁".repeat(20000);
  archive = await prepareArchive(records);
  await db.run(
    sql`UPDATE local_recovery_action_archives SET descriptor=${JSON.stringify(archive.checkpoint)}`,
  );
  expect(archive.checkpoint.byteLength).toBeGreaterThan(65536);
  expect((await save()).changed).toBe(true);
  expect((await load()).payload).toEqual(archive.payload);
});

it("serializes all five catalog removals across archive publication", async () => {
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
      "local_recovery_action_archives",
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
  "preserves %s temporary archive evidence",
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
it("refuses a symlinked archive directory without writing its target", async () => {
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
  "preserves archive evidence after %s failure",
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
  "refuses %s archive bytes before source SQL allocation",
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
      loadRegisteredSharedRecoveryActionArchivePayload({
        ...options(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["utf8", "json", "noncanonical", "bom"])(
  "refuses hash-matching invalid %s archive bytes before SQL allocation",
  async (state) => {
    const content =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(archive.payload))
            : Buffer.from(JSON.stringify(archive.payload, null, 2));
    const checkpoint = {
      ...archive.checkpoint,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
    await db.run(
      sql`UPDATE local_recovery_action_archives SET descriptor=${JSON.stringify(checkpoint)}`,
    );
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryActionArchivePayload({
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
  "archive-binding",
  "execution-binding",
  "original-binding",
  "shared-file",
  "original-file",
  "original-temporary",
  "local-file",
  "execution-file",
  "execution-temporary",
])(
  "refuses %s changes after saved sources and during final source SQL validation",
  async (change) => {
    await save();
    let calls = 0;
    await expect(
      loadRegisteredSharedRecoveryActionArchivePayload({
        ...options(),
        createValidationDatabase: async () => {
          if (++calls === 6) {
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
            if (change === "archive-binding")
              await db.run(
                sql`UPDATE local_recovery_action_archives SET descriptor=${JSON.stringify({ ...archive.checkpoint, sha256: "b".repeat(64) })}`,
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
            if (change === "execution-file")
              await fs.writeFile(sourcePath("executions"), "changed");
            if (change === "execution-temporary")
              await fs.writeFile(sourceTemporary("executions"), "partial");
          }
          return factory();
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(6);
  },
);
it.each(sourceNames)(
  "keeps published archive evidence if the %s source changes during publication",
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

it.each(["save", "load"] as const)(
  "%s checks exact source SQL values even when all five canonical hashes match",
  async (operation) => {
    const projection = recovery.parseSharedRecoveryProjection({
      ...shared.projection,
      tables: shared.projection.tables.map(({ name }) => ({
        name,
        rows:
          name === "namespace"
            ? [row(1)]
            : name === "warp"
              ? [
                  {
                    id: ["text", "w"],
                    namespace_id: ["text", "n"],
                    pos_x: ["integer", "0"],
                    pos_y: ["real", "3ff0000000000000"],
                  },
                ]
              : [],
      })),
    });
    shared = await recovery.describeSharedRecoveryHistory(
      {
        baseline: { id: "baseline", projection },
        effectSets: [
          { id: "edit", effects: [] },
          { id: "empty", effects: [] },
        ],
      },
      identity,
      {
        baselineId: "baseline",
        effectSets: [
          { id: "edit", effectCount: 0 },
          { id: "empty", effectCount: 0 },
        ],
      },
    );
    const groups = JSON.parse(JSON.stringify(executions.payload.effectSets));
    groups[0].effects = [];
    executions = await recovery.describeSharedRecoveryExecutions({
      checkpoint: shared.checkpoint,
      sharedHistory: shared.payload,
      selection: executions.payload.selection,
      effectSets: groups,
    });
    originals = await recovery.describeSharedRecoveryActions({
      checkpoint: executions.checkpoint,
      executions: executions.payload,
      sharedHistory: shared.payload,
      selection: originals.payload.selection,
      actions: originals.payload.actions,
    });
    archive = await prepareArchive();
    // Inject coherent metadata and bytes that only actual SQL read-back can refuse.
    await db.run(
      sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(shared.checkpoint)}`,
    );
    await db.run(
      sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(executions.checkpoint)}`,
    );
    await db.run(
      sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify(originals.checkpoint)}`,
    );
    await db.run(
      sql`UPDATE local_recovery_action_archives SET descriptor=${JSON.stringify(archive.checkpoint)}`,
    );
    await fs.writeFile(sourcePath("actions"), JSON.stringify(originals.payload));
    await fs.writeFile(sourcePath("shared"), JSON.stringify(shared.payload));
    await fs.writeFile(sourcePath("executions"), JSON.stringify(executions.payload));
    if (operation === "load") {
      await fs.mkdir(directory());
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
        ? saveRegisteredSharedRecoveryActionArchivePayload({ ...input, input: archive.payload })
        : loadRegisteredSharedRecoveryActionArchivePayload(input),
    ).rejects.toThrow("differs from projection");
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
      expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
      expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
    }
    if (operation === "load") expect(await fs.readFile(published())).toEqual(bytes());
    else expect(existsSync(directory())).toBe(false);
  },
);

it.each(["save", "load"] as const)("%s keeps an archive without selected actions", async (mode) => {
  const expected = { ...identity, checkpointId: "no-selected-actions" };
  const localOnly = await recovery.captureLocalRecoveryCheckpoint(db, expected, async () => ({
    baselineId: "baseline",
    effectSetIds: [],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, localOnly.checkpoint);
  const history = await recovery.describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: shared.payload.history.baseline.projection },
      effectSets: [],
    },
    expected,
    { baselineId: "baseline", effectSets: [] },
  );
  await recovery.rememberSharedRecoveryCheckpoint(db, history.checkpoint);
  const selected = await recovery.describeSharedRecoveryExecutions({
    checkpoint: history.checkpoint,
    sharedHistory: history.payload,
    selection: { baselineId: "baseline", effectSets: [] },
    effectSets: [],
  });
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, selected.checkpoint);
  const current = await recovery.describeSharedRecoveryActions({
    checkpoint: selected.checkpoint,
    executions: selected.payload,
    sharedHistory: history.payload,
    selection: { actionIds: [] },
    actions: [],
  });
  await recovery.rememberSharedRecoveryActionCheckpoint(db, current.checkpoint);
  const records = archive.payload.actions.filter((a) => a.rootId === "detached");
  const broader = await recovery.describeSharedRecoveryActionArchive({
    checkpoint: current.checkpoint,
    originals: current.payload,
    executions: selected.payload,
    sharedHistory: history.payload,
    selection: { rootIds: ["detached"], actionIds: records.map((a) => a.id) },
    actions: records,
  });
  await recovery.rememberSharedRecoveryActionArchiveCheckpoint(db, broader.checkpoint);
  const input = {
    ...options(),
    expected,
    localMaxBytes: localOnly.checkpoint.byteLength,
    sharedMaxBytes: history.checkpoint.byteLength,
    executionMaxBytes: selected.checkpoint.byteLength,
    actionMaxBytes: current.checkpoint.byteLength,
    maxBytes: broader.checkpoint.byteLength,
  };
  await saveRegisteredLocalRecoveryPayload({ ...input, input: localOnly.snapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...input, input: history.payload });
  await executionLoader.saveRegisteredSharedRecoveryExecutionPayload({
    ...input,
    input: selected.payload,
  });
  await actionLoader.saveRegisteredSharedRecoveryActionPayload({
    ...input,
    input: current.payload,
  });
  const saved = await saveRegisteredSharedRecoveryActionArchivePayload({
    ...input,
    input: broader.payload,
  });
  expect(saved.changed).toBe(true);
  if (mode === "load")
    expect((await loadRegisteredSharedRecoveryActionArchivePayload(input)).payload).toEqual(
      broader.payload,
    );
  expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});

it.each(["save", "load"] as const)(
  "%s rechecks every original catalog after archive content verification",
  async (mode) => {
    if (mode === "load") await save();
    const verify = recovery.requireSharedRecoveryActionArchiveCheckpoint;
    const tables = [
      "local_recovery_action_archives",
      "local_recovery_actions",
      "local_recovery_executions",
      "local_recovery_shared_history",
      "local_recovery_checkpoint",
    ];
    const before = await Promise.all(
      tables.map((table) =>
        db.get<{ descriptor: string; local_descriptor?: string; created_at: number }>(
          sql.raw(
            `SELECT descriptor, created_at${table === "local_recovery_checkpoint" ? "" : ", local_descriptor"} FROM ${table}`,
          ),
        ),
      ),
    );
    for (const table of tables) {
      vi.spyOn(recovery, "requireSharedRecoveryActionArchiveCheckpoint").mockImplementationOnce(
        async (...args) => {
          const result = await verify(...args);
          await db.run(sql.raw(`DELETE FROM ${table}`));
          return result;
        },
      );
      await expect(mode === "save" ? save() : load()).rejects.toThrow();
      if (mode === "save") expect(existsSync(directory())).toBe(false);
      else expect(await fs.readFile(published())).toEqual(bytes());
      const original = before[tables.indexOf(table)];
      await db.run(
        table === "local_recovery_checkpoint"
          ? sql`INSERT INTO local_recovery_checkpoint VALUES(${key.workspaceId},${key.deviceId},${key.epochId},${key.checkpointId},${original.descriptor},${original.created_at})`
          : sql`INSERT INTO ${sql.raw(table)} VALUES(${key.workspaceId},${key.deviceId},${key.epochId},${key.checkpointId},${original.descriptor},${original.local_descriptor},${original.created_at})`,
      );
    }
  },
);

it.each(["save", "load"] as const)(
  "%s rechecks every source file and temporary path after archive verification",
  async (mode) => {
    if (mode === "load") await save();
    const verify = recovery.requireSharedRecoveryActionArchiveCheckpoint;
    for (const source of sourceNames)
      for (const state of ["changed", "temporary"]) {
        const content = await fs.readFile(sourcePath(source));
        vi.spyOn(recovery, "requireSharedRecoveryActionArchiveCheckpoint").mockImplementationOnce(
          async (...args) => {
            const result = await verify(...args);
            await fs.writeFile(
              state === "changed" ? sourcePath(source) : sourceTemporary(source),
              "changed",
            );
            return result;
          },
        );
        await expect(mode === "save" ? save() : load()).rejects.toThrow();
        if (mode === "save") expect(existsSync(directory())).toBe(false);
        else expect(await fs.readFile(published())).toEqual(bytes());
        if (state === "changed") await fs.writeFile(sourcePath(source), content);
        else await fs.unlink(sourceTemporary(source));
      }
  },
);
