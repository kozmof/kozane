import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { migrateNodeDatabase } from "../../db/tx.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import * as sharedLoader from "./shared-recovery-payload.js";
import * as originalArchiveLoader from "./shared-recovery-action-archive-payload.js";
import * as actionLoader from "./shared-recovery-action-payload.js";
import * as executionLoader from "./shared-recovery-execution-payload.js";
import {
  saveRegisteredSharedRecoveryRunArchivePayload,
  loadRegisteredSharedRecoveryRunArchivePayload,
  inspectRegisteredSharedRecoveryRunArchivePayload,
} from "./shared-recovery-run-archive-payload.js";
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
let mainDatabase: Awaited<ReturnType<typeof openDb>> | undefined;
let local: Awaited<ReturnType<typeof recovery.captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof recovery.describeSharedRecoveryHistory>>;
let executions: Awaited<ReturnType<typeof recovery.describeSharedRecoveryExecutions>>;
let originalArchive: Awaited<ReturnType<typeof recovery.describeSharedRecoveryActionArchive>>;
let archive: Awaited<ReturnType<typeof recovery.describeSharedRecoveryRunArchive>>;
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
const directory = () => join(root, ".kozane", "recovery", "run-archives");
const published = () => join(directory(), `${archive.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${archive.checkpoint.sha256}.json`);
type Source = "local" | "shared" | "executions" | "actions" | "actionArchive";
const sourceNames = ["local", "shared", "executions", "actions", "actionArchive"] as const;
const sourceDescriptor = (source: Source) =>
  source === "local"
    ? local.checkpoint
    : source === "shared"
      ? shared.checkpoint
      : source === "executions"
        ? executions.checkpoint
        : source === "actions"
          ? originals.checkpoint
          : originalArchive.checkpoint;
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
          : source === "actions"
            ? "actions"
            : "action-archives",
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
  actionArchiveMaxBytes: originalArchive.checkpoint.byteLength,
  maxBytes: archive?.checkpoint.byteLength ?? 1,
  createValidationDatabase: factory,
});
const save = () =>
  saveRegisteredSharedRecoveryRunArchivePayload({ ...options(), input: archive.payload });
const load = () => loadRegisteredSharedRecoveryRunArchivePayload(options());
const inspect = () => inspectRegisteredSharedRecoveryRunArchivePayload(root, db, key);
const catalog = async () => ({
  archive: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_run_archives`,
  ),
  actionArchive: await db.values(
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
  mainDatabase = await openDb(`file:${join(root, "db.sqlite")}`);
  db = mainDatabase.db;
  await migrateNodeDatabase(db, { migrationsFolder: resolve("drizzle") });
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
  originalArchive = await prepareOriginalArchive();
  await recovery.rememberSharedRecoveryActionArchiveCheckpoint(db, originalArchive.checkpoint);
  archive = await prepareRunArchive();
  await recovery.rememberSharedRecoveryRunArchiveCheckpoint(db, archive.checkpoint);
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
  await originalArchiveLoader.saveRegisteredSharedRecoveryActionArchivePayload({
    ...options(),
    input: originalArchive.payload,
  });
});
afterEach(async () => {
  for (const opened of validationDatabases.splice(0)) opened.close();
  mainDatabase?.close();
  mainDatabase = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
async function prepareOriginalArchive(actions?: unknown) {
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

async function prepareRunArchive(records?: unknown) {
  if (records)
    return recovery.describeSharedRecoveryRunArchive({
      checkpoint: originalArchive.checkpoint,
      selection: {
        effectSets: (records as recovery.SharedRecoveryRetainedSet[]).map((set) => ({
          id: set.id,
          rootId: set.rootId,
          source: set.source,
          baselineId: set.history.selection.baselineId,
          effectCount: set.history.selection.effectSets[0].effectCount,
          executionCount: set.executions.selection.effectSets[0].executionCount,
        })),
      },
      effectSets: records,
      actionArchive: originalArchive.payload,
      originals: originals.payload,
      executions: executions.payload,
      sharedHistory: shared.payload,
    });
  const sets: recovery.SharedRecoveryRetainedSet[] = [];
  const inventory: recovery.SharedRecoveryRetainedSelection["effectSets"][number][] = [];
  const selectedBefore = new Map<string, recovery.SharedRecoveryProjection>();
  let currentBefore = shared.payload.history.baseline.projection;
  for (const set of shared.payload.history.effectSets) {
    selectedBefore.set(set.id, currentBefore);
    currentBefore = recovery.reconstructSharedRecoveryProjection(
      { baseline: { id: "cursor", projection: currentBefore }, effectSets: [set] },
      { baselineId: "cursor", effectSets: [{ id: set.id, effectCount: set.effects.length }] },
    );
  }
  const context = (n?: number) => ({
    ...shared.payload.history.baseline.projection,
    tables: shared.payload.history.baseline.projection.tables.map((t) => ({
      ...t,
      rows:
        t.name === "namespace" && n !== undefined ? [row(n)] : t.name === "namespace" ? [] : t.rows,
    })),
  });
  for (const [id, source, before, after, childRef, extra, skipped] of [
    ["origin", "origin", 7, 8, 5, false, true],
    ["empty", "authoritative", undefined, undefined, undefined, false, false],
    ["detached-origin", "origin", 21, 22, 18, true, true],
    ["superseded", "rebase", 9, 10, 11, false, false],
    ["detached-rebase", "rebase", 25, 26, 23, true, false],
    ["edit", "rebase", undefined, undefined, undefined, false, false],
    ["detached-authoritative", "authoritative", 29, undefined, 27, true, false],
  ] as const) {
    const selected = id === "edit" || id === "empty";
    const group = clone(executions.payload.effectSets[id === "empty" ? 1 : 0]);
    group.id = id;
    if (extra) {
      const originalsById = new Map(originalArchive.payload.actions.map((a) => [a.id, a]));
      const root = originalsById.get("detached")!,
        child = originalsById.get("detached-child")!,
        grand = originalsById.get("detached-grand")!,
        skip = originalsById.get("detached-skipped")!;
      group.invocation = {
        id: root.id,
        kind: root.kind,
        contractVersion: root.contractVersion,
        input: root.input,
      };
      group.generated = root.generated;
      group.executions = [
        {
          ...group.invocation,
          parentId: null,
          executionOrd: 0,
          generated: {
            child: root.generated.child,
            ...(skipped ? { skipped: root.generated.skipped } : {}),
          },
        },
        {
          id: child.id,
          kind: child.kind,
          contractVersion: child.contractVersion,
          parentId: root.id,
          executionOrd: 1,
          input: { ref: reference(childRef!) },
          generated: { grand: root.generated.grand },
        },
        {
          id: grand.id,
          kind: grand.kind,
          contractVersion: grand.contractVersion,
          parentId: child.id,
          executionOrd: 2,
          input: { ref: reference(childRef! + 1) },
          generated: {},
        },
        ...(skipped
          ? [
              {
                id: skip.id,
                kind: skip.kind,
                contractVersion: skip.contractVersion,
                parentId: root.id,
                executionOrd: 3,
                input: skip.input,
                generated: {},
              },
            ]
          : []),
      ];
      group.effects =
        after === undefined
          ? []
          : [
              { ord: 0, actionId: child.id, executionOrd: 1 },
              { ord: 1, actionId: grand.id, executionOrd: 2 },
            ];
    } else if (!selected) {
      group.executions[1].input = { ref: reference(childRef!) };
      group.effects = [
        { ord: 0, actionId: "child", executionOrd: 1 },
        { ord: 1, actionId: "root", executionOrd: 0 },
      ];
      if (skipped) {
        group.executions[0].generated.skipped = group.generated.skipped;
        group.executions.push({
          id: "skipped",
          kind: "future.skipped",
          contractVersion: 99,
          parentId: "root",
          executionOrd: 2,
          input: { ref: reference(6) },
          generated: {},
        });
      }
    }
    const fx = selected
      ? shared.payload.history.effectSets[id === "empty" ? 1 : 0].effects
      : after === undefined
        ? []
        : [
            {
              ord: 0,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "U",
              before: row(before!),
              after: row(after),
            },
            {
              ord: 1,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "D",
              before: row(after),
              after: null,
            },
          ];
    const history = await recovery.describeSharedRecoveryHistory(
      {
        baseline: {
          id: `before-${id}`,
          projection: selected ? selectedBefore.get(id)! : context(before),
        },
        effectSets: [{ id, effects: fx }],
      },
      identity,
      { baselineId: `before-${id}`, effectSets: [{ id, effectCount: fx.length }] },
    );
    const run = await recovery.describeSharedRecoveryExecutions({
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
      executions: run.payload,
    });
    inventory.push({
      id,
      rootId: group.invocation.id,
      source,
      baselineId: `before-${id}`,
      effectCount: fx.length,
      executionCount: group.executions.length,
    });
  }
  return recovery.describeSharedRecoveryRunArchive({
    checkpoint: originalArchive.checkpoint,
    selection: { effectSets: inventory },
    effectSets: sets,
    actionArchive: originalArchive.payload,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
}

it("publishes independent broader runs after all six expectations commit and preserves source bytes", async () => {
  const before = await catalog(),
    sourceBytes = await Promise.all(sourceNames.map((source) => fs.readFile(sourcePath(source))));
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      for (const [table, descriptor] of [
        ["local_recovery_run_archives", archive.checkpoint],
        ["local_recovery_action_archives", originalArchive.checkpoint],
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

it("reopens independent contexts, nested and skipped executions and exact selected runs without writes or live installation", async () => {
  await save();
  const before = await catalog(),
    reopened = await openDb(`file:${join(root, "db.sqlite")}`),
    targets: Awaited<ReturnType<typeof factory>>[] = [];
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredSharedRecoveryRunArchivePayload({
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
    expect(result.payload.effectSets.map((s) => s.id)).toEqual([
      "origin",
      "empty",
      "detached-origin",
      "superseded",
      "detached-rebase",
      "edit",
      "detached-authoritative",
    ]);
    const origin = result.payload.effectSets[2].executions.effectSets[0],
      rebased = result.payload.effectSets[4].executions.effectSets[0];
    expect(origin.executions.map((a) => a.id)).toEqual([
      "detached",
      "detached-child",
      "detached-grand",
      "detached-skipped",
    ]);
    expect(origin.invocation.contractVersion).toBe(77);
    expect(origin.invocation.input).toHaveProperty("text", '\ufeff{"exact":true}\0🪁');
    expect(origin.executions[1].input).toEqual({ ref: reference(18) });
    expect(rebased.executions[1].input).toEqual({ ref: reference(23) });
    expect(result.payload.effectSets[5].executions.effectSets[0]).toEqual(
      executions.payload.effectSets[0],
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.effectSets[2].history.history.baseline.projection)).toBe(
      true,
    );
  } finally {
    reopened.close();
  }
  // Twelve saved-source checks and both endpoints of seven independent runs.
  expect(targets).toHaveLength(26);
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
  "actionArchiveMaxBytes",
] as const)("enforces independent %s before file reads or SQL allocation", async (field) => {
  await save();
  const input = options();
  input[field]--;
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  await expect(
    loadRegisteredSharedRecoveryRunArchivePayload({
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
      "actionArchiveMaxBytes",
    ])
      await expect(
        loadRegisteredSharedRecoveryRunArchivePayload({
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
      loadRegisteredSharedRecoveryRunArchivePayload({
        ...options(),
        expected: { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([
  "local_recovery_run_archives",
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
    loadRegisteredSharedRecoveryRunArchivePayload({
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
  const run = input.effectSets[4];
  if (change === "source") input.checkpoint.sha256 = "b".repeat(64);
  if (change === "truncation") {
    input.effectSets = input.effectSets.filter((s: { rootId: string }) => s.rootId !== "detached");
    input.selection.effectSets = input.selection.effectSets.filter(
      (s: { rootId: string }) => s.rootId !== "detached",
    );
  }
  if (change === "inventory") input.selection.effectSets.pop();
  if (change === "input") run.executions.effectSets[0].executions[1].input.ref = reference(40);
  if (change === "current-original")
    input.effectSets[5].executions.effectSets[0].executions[1].input.ref = reference(40);
  if (change === "unused-binding") run.executions.effectSets[0].generated.unused.value = "changed";
  if (change === "sequence") run.executions.effectSets[0].executions[1].executionOrd = 2;
  if (change === "provenance") {
    run.source = "authoritative";
    input.selection.effectSets[4].source = "authoritative";
  }
  const create = vi.fn(factory);
  await expect(
    saveRegisteredSharedRecoveryRunArchivePayload({
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
      input.input.effectSets.length = 0;
      input.expected.deviceId = "changed";
      input.root = join(root, "elsewhere");
      input.localMaxBytes = 0;
      input.sharedMaxBytes = 0;
      input.executionMaxBytes = 0;
      input.actionMaxBytes = 0;
      input.actionArchiveMaxBytes = 0;
      input.maxBytes = 0;
      return factory();
    };
    if (mode === "save") await saveRegisteredSharedRecoveryRunArchivePayload(input);
    else
      expect((await loadRegisteredSharedRecoveryRunArchivePayload(input)).payload).toEqual(
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
    const validate = recovery.validateSharedRecoveryRunArchive;
    vi.spyOn(recovery, "validateSharedRecoveryRunArchive").mockImplementationOnce(
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
        ? saveRegisteredSharedRecoveryRunArchivePayload({
            ...options(),
            input: archive.payload,
            db: wrapped,
          })
        : loadRegisteredSharedRecoveryRunArchivePayload({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);

it("refuses coherent replacement of all six bindings after archive verification", async () => {
  const validate = recovery.validateSharedRecoveryRunArchive;
  vi.spyOn(recovery, "validateSharedRecoveryRunArchive").mockImplementationOnce(async (...args) => {
    const result = await validate(...args),
      nextLocal = { ...local.checkpoint, sha256: "b".repeat(64) },
      nextShared = { ...shared.checkpoint, sha256: "c".repeat(64) },
      nextExecution = {
        ...executions.checkpoint,
        checkpoint: nextShared,
        sha256: "d".repeat(64),
      },
      nextOriginal = { ...originals.checkpoint, checkpoint: nextExecution },
      nextOriginalArchive = { ...originalArchive.checkpoint, checkpoint: nextOriginal },
      nextArchive = { ...archive.checkpoint, checkpoint: nextOriginalArchive };
    await withTx(db, async (tx) => {
      await tx.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
      );
      for (const [table, descriptor] of [
        ["local_recovery_shared_history", nextShared],
        ["local_recovery_executions", nextExecution],
        ["local_recovery_actions", nextOriginal],
        ["local_recovery_action_archives", nextOriginalArchive],
        ["local_recovery_run_archives", nextArchive],
      ] as const)
        await tx.run(
          sql`UPDATE ${sql.raw(table)} SET descriptor=${JSON.stringify(descriptor)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
    });
    return result;
  });
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});

it("saves and reopens a detached child input larger than the verification buffer", async () => {
  const records = clone(archive.payload.effectSets);
  records[4].executions.effectSets[0].executions[1].input.text = "🪁".repeat(20000);
  archive = await prepareRunArchive(records);
  await db.run(
    sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify(archive.checkpoint)}`,
  );
  expect(archive.checkpoint.byteLength).toBeGreaterThan(65536);
  expect((await save()).changed).toBe(true);
  expect((await load()).payload).toEqual(archive.payload);
});

it("serializes all six catalog removals across archive publication", async () => {
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
      "local_recovery_run_archives",
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
      loadRegisteredSharedRecoveryRunArchivePayload({
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
      sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify(checkpoint)}`,
    );
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryRunArchivePayload({
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
])("refuses %s changes after saved sources and during run SQL validation", async (change) => {
  await save();
  let calls = 0;
  await expect(
    loadRegisteredSharedRecoveryRunArchivePayload({
      ...options(),
      createValidationDatabase: async () => {
        if (++calls === 13) {
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
              sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify({ ...archive.checkpoint, sha256: "b".repeat(64) })}`,
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
  expect(calls).toBe(26);
});
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
  "%s checks exact source SQL values even when all six canonical hashes match",
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
    originalArchive = await prepareOriginalArchive();
    archive = await prepareRunArchive();
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
      sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify(archive.checkpoint)}`,
    );
    await db.run(
      sql`UPDATE local_recovery_action_archives SET descriptor=${JSON.stringify(originalArchive.checkpoint)}`,
    );
    await fs.writeFile(sourcePath("actionArchive"), JSON.stringify(originalArchive.payload));
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
        ? saveRegisteredSharedRecoveryRunArchivePayload({ ...input, input: archive.payload })
        : loadRegisteredSharedRecoveryRunArchivePayload(input),
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
  const records = originalArchive.payload.actions.filter((a) => a.rootId === "detached");
  const broader = await recovery.describeSharedRecoveryActionArchive({
    checkpoint: current.checkpoint,
    originals: current.payload,
    executions: selected.payload,
    sharedHistory: history.payload,
    selection: { rootIds: ["detached"], actionIds: records.map((a) => a.id) },
    actions: records,
  });
  await recovery.rememberSharedRecoveryActionArchiveCheckpoint(db, broader.checkpoint);
  const sets = [];
  for (const set of archive.payload.effectSets.filter((s) => s.rootId === "detached")) {
    const rows = await recovery.describeSharedRecoveryHistory(
      set.history.history,
      expected,
      set.history.selection,
    );
    const run = await recovery.describeSharedRecoveryExecutions({
      checkpoint: rows.checkpoint,
      sharedHistory: rows.payload,
      selection: set.executions.selection,
      effectSets: set.executions.effectSets,
    });
    sets.push({ ...set, history: rows.payload, executions: run.payload });
  }
  const runs = await recovery.describeSharedRecoveryRunArchive({
    checkpoint: broader.checkpoint,
    actionArchive: broader.payload,
    originals: current.payload,
    executions: selected.payload,
    sharedHistory: history.payload,
    selection: {
      effectSets: archive.payload.selection.effectSets.filter((s) => s.rootId === "detached"),
    },
    effectSets: sets,
  });
  await recovery.rememberSharedRecoveryRunArchiveCheckpoint(db, runs.checkpoint);
  const input = {
    ...options(),
    expected,
    localMaxBytes: localOnly.checkpoint.byteLength,
    sharedMaxBytes: history.checkpoint.byteLength,
    executionMaxBytes: selected.checkpoint.byteLength,
    actionMaxBytes: current.checkpoint.byteLength,
    actionArchiveMaxBytes: broader.checkpoint.byteLength,
    maxBytes: runs.checkpoint.byteLength,
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
  await originalArchiveLoader.saveRegisteredSharedRecoveryActionArchivePayload({
    ...input,
    input: broader.payload,
  });
  const create = vi.fn(factory);
  const saved = await saveRegisteredSharedRecoveryRunArchivePayload({
    ...input,
    input: runs.payload,
    createValidationDatabase: create,
  });
  expect(create).toHaveBeenCalledTimes(19);
  expect(saved.changed).toBe(true);
  if (mode === "load")
    expect((await loadRegisteredSharedRecoveryRunArchivePayload(input)).payload).toEqual(
      runs.payload,
    );
  expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});

it.each(
  (["save", "load"] as const).flatMap((mode) =>
    [
      "local_recovery_run_archives",
      "local_recovery_action_archives",
      "local_recovery_actions",
      "local_recovery_executions",
      "local_recovery_shared_history",
      "local_recovery_checkpoint",
    ].map((table) => ({ mode, table })),
  ),
)("$mode rechecks $table after run validation", async ({ mode, table }) => {
  if (mode === "load") await save();
  const verify = recovery.validateSharedRecoveryRunArchive;
  vi.spyOn(recovery, "validateSharedRecoveryRunArchive").mockImplementationOnce(async (...args) => {
    const result = await verify(...args);
    await db.run(sql.raw(`DELETE FROM ${table}`));
    return result;
  });
  await expect(mode === "save" ? save() : load()).rejects.toThrow();
  if (mode === "save") expect(existsSync(directory())).toBe(false);
  else expect(await fs.readFile(published())).toEqual(bytes());
});

it.each(
  (["save", "load"] as const).flatMap((mode) =>
    sourceNames.flatMap((source) =>
      ["changed", "temporary"].map((state) => ({ mode, source, state })),
    ),
  ),
)(
  "$mode rechecks $source $state evidence after run validation",
  async ({ mode, source, state }) => {
    if (mode === "load") await save();
    const verify = recovery.validateSharedRecoveryRunArchive;
    vi.spyOn(recovery, "validateSharedRecoveryRunArchive").mockImplementationOnce(
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
  },
);
async function changeRun(index: number, change: (set: any) => void) {
  const sets = clone(archive.payload.effectSets),
    set = sets[index];
  change(set);
  const history = await recovery.describeSharedRecoveryHistory(
    set.history.history,
    identity,
    set.history.selection,
  );
  set.history = history.payload;
  const executions = await recovery.describeSharedRecoveryExecutions({
    checkpoint: history.checkpoint,
    sharedHistory: history.payload,
    selection: set.executions.selection,
    effectSets: set.executions.effectSets,
  });
  set.executions = executions.payload;
  archive = await prepareRunArchive(sets);
  await db.run(
    sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify(archive.checkpoint)}`,
  );
}
it.each(
  (["save", "load"] as const).flatMap((mode) =>
    ["before-affinity", "after-foreign-key"].map((defect) => ({ mode, defect })),
  ),
)("$mode checks detached $defect states even when all hashes match", async ({ mode, defect }) => {
  await changeRun(4, (set) => {
    const warp = {
      id: ["text", "w"],
      namespace_id: ["text", defect === "before-affinity" ? "n" : "missing"],
      pos_x: ["integer", "0"],
      pos_y: defect === "before-affinity" ? ["real", "3ff0000000000000"] : ["integer", "0"],
    };
    if (defect === "before-affinity")
      set.history.history.baseline.projection.tables
        .find((t: { name: string }) => t.name === "warp")
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
      set.executions.effectSets[0].effects.push({ ord: 2, actionId: "detached", executionOrd: 0 });
    }
  });
  if (mode === "load") {
    await fs.mkdir(directory());
    await fs.writeFile(published(), bytes());
  }
  const targets: Awaited<ReturnType<typeof factory>>[] = [];
  const input = {
    ...options(),
    createValidationDatabase: async () => {
      const db = await factory();
      targets.push(db);
      return db;
    },
  };
  await expect(
    mode === "save"
      ? saveRegisteredSharedRecoveryRunArchivePayload({ ...input, input: archive.payload })
      : loadRegisteredSharedRecoveryRunArchivePayload(input),
  ).rejects.toThrow();
  expect(targets).toHaveLength(defect === "before-affinity" ? 21 : 22);
  for (const db of targets) {
    expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await db.values(sql`SELECT 1 FROM warp`)).toEqual([]);
    expect(await db.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
  }
  if (mode === "save") expect(existsSync(directory())).toBe(false);
  else expect(await fs.readFile(published())).toEqual(bytes());
});
it.each(["save", "load"] as const)(
  "%s refuses an endpoint validation commit failure and preserves evidence",
  async (mode) => {
    if (mode === "load") await save();
    let calls = 0;
    const before = await catalog(),
      targets: Awaited<ReturnType<typeof factory>>[] = [];
    const input = {
      ...options(),
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        if (++calls !== 13) return target;
        return createDatabaseAdapter(new Proxy(target, {}), {
          read: (work) => withReadTx(target, (tx) => work(tx as unknown as DatabaseHandle)),
          write: (work) =>
            withTx(target, async (tx) => {
              await work(tx);
              throw Error("Endpoint commit failed");
            }),
        });
      },
    };
    await expect(
      mode === "save"
        ? saveRegisteredSharedRecoveryRunArchivePayload({ ...input, input: archive.payload })
        : loadRegisteredSharedRecoveryRunArchivePayload(input),
    ).rejects.toThrow("Endpoint commit failed");
    expect(calls).toBe(13);
    expect(await catalog()).toEqual(before);
    for (const db of targets) expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    if (mode === "save") expect(existsSync(directory())).toBe(false);
    else expect(await fs.readFile(published())).toEqual(bytes());
  },
);
