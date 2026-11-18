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
import * as executionLoader from "./shared-recovery-execution-payload.js";
import {
  saveRegisteredSharedRecoveryActionPayload,
  loadRegisteredSharedRecoveryActionPayload,
  inspectRegisteredSharedRecoveryActionPayload,
} from "./shared-recovery-action-payload.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
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
const directory = () => join(root, ".kozane", "recovery", "actions");
const published = () => join(directory(), `${originals.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${originals.checkpoint.sha256}.json`);
type Source = "local" | "shared" | "executions";
const sourceDescriptor = (source: Source) =>
  source === "local"
    ? local.checkpoint
    : source === "shared"
      ? shared.checkpoint
      : executions.checkpoint;
const sourceDirectory = (source: Source) =>
  join(
    root,
    ".kozane",
    "recovery",
    source === "local" ? "checkpoints" : source === "shared" ? "shared-history" : "executions",
  );
const sourcePath = (source: Source) =>
  join(sourceDirectory(source), `${sourceDescriptor(source).sha256}.json`);
const sourceTemporary = (source: Source) =>
  join(sourceDirectory(source), `.pending-${sourceDescriptor(source).sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(originals.payload), "utf8");
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  executionMaxBytes: executions.checkpoint.byteLength,
  maxBytes: originals.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const save = () =>
  saveRegisteredSharedRecoveryActionPayload({ ...options(), input: originals.payload });
const load = () => loadRegisteredSharedRecoveryActionPayload(options());
const inspect = () => inspectRegisteredSharedRecoveryActionPayload(root, db, key);
const catalog = async () => ({
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
  root = await fs.mkdtemp(join(tmpdir(), "kozane-action-payload-"));
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
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
  await executionLoader.saveRegisteredSharedRecoveryExecutionPayload({
    ...options(),
    input: executions.payload,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("publishes canonical originals after all four expectations commit and preserves source files", async () => {
  const before = await catalog();
  const sourceBytes = await Promise.all(
    (["local", "shared", "executions"] as const).map((source) => fs.readFile(sourcePath(source))),
  );
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      for (const [table, descriptor] of [
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
    binding: { checkpoint: originals.checkpoint, localCheckpoint: local.checkpoint },
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
  expect(
    await Promise.all(
      (["local", "shared", "executions"] as const).map((source) => fs.readFile(sourcePath(source))),
    ),
  ).toEqual(sourceBytes);
  expect(await catalog()).toEqual(before);
  expect(existsSync(join(root, ".kozane", "assets"))).toBe(false);
});

it("inspects missing and orphaned evidence without creating directories or authorizing reads", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_executions`);
  await db.run(sql`DELETE FROM local_recovery_shared_history`);
  await db.run(sql`DELETE FROM local_recovery_checkpoint`);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(save()).rejects.toThrow();
  await expect(load()).rejects.toThrow();
  expect(await fs.readFile(published())).toEqual(bytes());
});

it("reopens original child inputs, skipped records and exact sequence strings without writes or live installation", async () => {
  await save();
  const before = await catalog(),
    reopened = await openDb(`file:${join(root, "db.sqlite")}`);
  const targets: Awaited<ReturnType<typeof factory>>[] = [];
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredSharedRecoveryActionPayload({
      ...options(),
      db: reopened.db,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    });
    expect(result).toEqual({
      payload: originals.payload,
      binding: { checkpoint: originals.checkpoint, localCheckpoint: local.checkpoint },
    });
    expect(result.payload.actions[1].input).toEqual({ ref: reference(5) });
    expect(executions.payload.effectSets[0].executions[1].input).toEqual({ ref: reference(3) });
    expect(result.payload.actions[2].id).toBe("skipped");
    expect(result.payload.actions.map(({ seq }) => seq)).toEqual([
      "1",
      "2",
      "9007199254740993",
      "9223372036854775807",
    ]);
    expect(result.payload.actions[0].contractVersion).toBe(99);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.actions[1].input)).toBe(true);
  } finally {
    reopened.close();
  }
  expect(targets).toHaveLength(3);
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
  expect(await catalog()).toEqual(before);
  expect(await fs.readFile(published())).toEqual(bytes());
});

it.each(["maxBytes", "localMaxBytes", "sharedMaxBytes", "executionMaxBytes"] as const)(
  "enforces independent %s limits before files or validation allocation",
  async (field) => {
    await save();
    const input = options();
    input[field]--;
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryActionPayload({ ...input, createValidationDatabase: create }),
    ).rejects.toThrow("exceeds read limit");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid byte limit %s before file reads",
  async (limit) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    for (const field of ["maxBytes", "localMaxBytes", "sharedMaxBytes", "executionMaxBytes"])
      await expect(
        loadRegisteredSharedRecoveryActionPayload({
          ...options(),
          [field]: limit,
          createValidationDatabase: create,
        }),
      ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it("requires the full host identity before file reads", async () => {
  await save();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  for (const field of ["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)
    await expect(
      loadRegisteredSharedRecoveryActionPayload({
        ...options(),
        expected: { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each(["actions", "executions", "shared", "local"])(
  "refuses missing %s expectations before file reads",
  async (which) => {
    await save();
    const table =
      which === "actions"
        ? "local_recovery_actions"
        : which === "executions"
          ? "local_recovery_executions"
          : which === "shared"
            ? "local_recovery_shared_history"
            : "local_recovery_checkpoint";
    await db.run(sql.raw(`DELETE FROM ${table}`));
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryActionPayload({ ...options(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([
  "first-child-input",
  "skipped-input",
  "sequence",
  "provenance",
  "truncated-selection",
  "unused-binding",
])("refuses altered original %s before SQL allocation or publication", async (change) => {
  const input = JSON.parse(JSON.stringify(originals.payload));
  if (change === "first-child-input") input.actions[1].input.ref = reference(3);
  if (change === "skipped-input") input.actions[2].input.ref = "changed";
  if (change === "sequence") input.actions[2].seq = "9007199254740994";
  if (change === "provenance") input.actions[2].hlc = "changed";
  if (change === "truncated-selection") {
    input.actions.splice(2, 1);
    input.selection.actionIds.splice(2, 1);
  }
  if (change === "unused-binding") input.actions[0].generated.unused.value = "changed";
  const create = vi.fn(factory);
  await expect(
    saveRegisteredSharedRecoveryActionPayload({
      ...options(),
      input,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow("content mismatch");
  expect(create).not.toHaveBeenCalled();
  expect(existsSync(directory())).toBe(false);
});
it.each(["local", "shared", "executions"] as const)(
  "requires the saved %s source and preserves temporary evidence",
  async (source) => {
    await fs.rename(sourcePath(source), sourceTemporary(source));
    const before = await fs.readFile(sourceTemporary(source));
    await expect(save()).rejects.toThrow();
    expect(existsSync(directory())).toBe(false);
    expect(await fs.readFile(sourceTemporary(source))).toEqual(before);
  },
);
it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary action evidence",
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
it("refuses a symlinked action directory without writing its target", async () => {
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
  "preserves action evidence after %s failure",
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
  "refuses %s action bytes before source SQL allocation",
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
      loadRegisteredSharedRecoveryActionPayload({ ...options(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["utf8", "json", "noncanonical", "bom"])(
  "refuses hash-matching invalid %s action bytes before SQL allocation",
  async (state) => {
    const content =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(originals.payload))
            : Buffer.from(JSON.stringify(originals.payload, null, 2));
    const checkpoint = {
      ...originals.checkpoint,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
    await db.run(sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify(checkpoint)}`);
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryActionPayload({
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
  "action-binding",
  "execution-binding",
  "local-file",
  "execution-file",
  "execution-temporary",
])("refuses %s changes after saved execution validation", async (change) => {
  await save();
  let calls = 0;
  await expect(
    loadRegisteredSharedRecoveryActionPayload({
      ...options(),
      createValidationDatabase: async () => {
        if (++calls === 3) {
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
          if (change === "action-binding")
            await db.run(
              sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...originals.checkpoint, sha256: "b".repeat(64) })}`,
            );
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
  expect(calls).toBe(3);
});
it.each(["local", "shared", "executions"] as const)(
  "keeps published original evidence if the %s source changes during publication",
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
it("refuses coherent replacement of all four bindings after action verification", async () => {
  const require = recovery.requireSharedRecoveryActionCheckpoint;
  vi.spyOn(recovery, "requireSharedRecoveryActionCheckpoint").mockImplementationOnce(
    async (...args) => {
      const result = await require(...args),
        nextLocal = { ...local.checkpoint, sha256: "b".repeat(64) },
        nextShared = { ...shared.checkpoint, sha256: "c".repeat(64) },
        nextExecution = {
          ...executions.checkpoint,
          checkpoint: nextShared,
          sha256: "d".repeat(64),
        };
      await withTx(db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(nextShared)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(nextExecution)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...originals.checkpoint, checkpoint: nextExecution })},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
      });
      return result;
    },
  );
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});
it.each(["save", "load"])(
  "owns original payload, identity, root and all limits during %s callbacks",
  async (mode) => {
    if (mode === "load") await save();
    const input = {
      ...options(),
      input: JSON.parse(JSON.stringify(originals.payload)),
      expected: { ...identity },
    };
    input.createValidationDatabase = async () => {
      input.input.actions.length = 0;
      input.expected.deviceId = "changed";
      input.root = join(root, "elsewhere");
      input.localMaxBytes = 0;
      input.sharedMaxBytes = 0;
      input.executionMaxBytes = 0;
      input.maxBytes = 0;
      return factory();
    };
    if (mode === "save") await saveRegisteredSharedRecoveryActionPayload(input);
    else
      expect((await loadRegisteredSharedRecoveryActionPayload(input)).payload).toEqual(
        originals.payload,
      );
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it.each(["save", "load"])(
  "preserves earlier evidence when the final %s commit fails",
  async (mode) => {
    if (mode === "load") await save();
    let ready = false;
    const require = recovery.requireSharedRecoveryActionCheckpoint;
    vi.spyOn(recovery, "requireSharedRecoveryActionCheckpoint").mockImplementationOnce(
      async (...args) => {
        const result = await require(...args);
        ready = true;
        return result;
      },
    );
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (operation) => withReadTx(db, (tx) => operation(tx as unknown as DatabaseHandle)),
      write: (operation) =>
        withTx(db, async (tx) => {
          const result = await operation(tx);
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
    if (mode === "save")
      await expect(
        saveRegisteredSharedRecoveryActionPayload({
          ...options(),
          input: originals.payload,
          db: wrapped,
        }),
      ).rejects.toThrow();
    else
      await expect(
        loadRegisteredSharedRecoveryActionPayload({ ...options(), db: wrapped }),
      ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);
it.each(["save", "load"] as const)(
  "%s checks exact source SQL values even when all four canonical hashes match",
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
        ? saveRegisteredSharedRecoveryActionPayload({ ...input, input: originals.payload })
        : loadRegisteredSharedRecoveryActionPayload(input),
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

it("saves and reopens an original skipped-child input larger than the verification buffer", async () => {
  const expected = { ...identity, checkpointId: "large" };
  const largeLocal = await recovery.captureLocalRecoveryCheckpoint(db, expected, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, largeLocal.checkpoint);
  const largeShared = await recovery.describeSharedRecoveryHistory(
    shared.payload.history,
    expected,
    shared.payload.selection,
  );
  await recovery.rememberSharedRecoveryCheckpoint(db, largeShared.checkpoint);
  const groups = JSON.parse(JSON.stringify(executions.payload.effectSets)),
    selection = JSON.parse(JSON.stringify(executions.payload.selection));
  const renameBindings = (bindings: Record<string, { type: string; value: string }>) => {
    for (const binding of Object.values(bindings))
      if (binding.type === "child-id") binding.value = `large-${binding.value}`;
  };
  for (const group of groups) {
    group.invocation.id = `large-${group.invocation.id}`;
    renameBindings(group.generated);
    for (const entry of group.executions) {
      entry.id = `large-${entry.id}`;
      if (entry.parentId !== null) entry.parentId = `large-${entry.parentId}`;
      renameBindings(entry.generated);
    }
    for (const effect of group.effects) effect.actionId = `large-${effect.actionId}`;
  }
  for (const selected of selection.effectSets) selected.rootId = `large-${selected.rootId}`;
  const largeExecution = await recovery.describeSharedRecoveryExecutions({
    checkpoint: largeShared.checkpoint,
    sharedHistory: largeShared.payload,
    selection,
    effectSets: groups,
  });
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, largeExecution.checkpoint);
  const actions = JSON.parse(JSON.stringify(originals.payload.actions));
  for (const action of actions) {
    action.id = `large-${action.id}`;
    action.rootId = `large-${action.rootId}`;
    if (action.parentId !== null) action.parentId = `large-${action.parentId}`;
    renameBindings(action.generated);
  }
  actions[2].input.text = "🪁".repeat(20000);
  const large = await recovery.describeSharedRecoveryActions({
    checkpoint: largeExecution.checkpoint,
    executions: largeExecution.payload,
    sharedHistory: largeShared.payload,
    selection: { actionIds: ["large-root", "large-child", "large-skipped", "large-empty-root"] },
    actions,
  });
  await recovery.rememberSharedRecoveryActionCheckpoint(db, large.checkpoint);
  const input = {
    ...options(),
    expected,
    localMaxBytes: largeLocal.checkpoint.byteLength,
    sharedMaxBytes: largeShared.checkpoint.byteLength,
    executionMaxBytes: largeExecution.checkpoint.byteLength,
    maxBytes: large.checkpoint.byteLength,
  };
  await saveRegisteredLocalRecoveryPayload({ ...input, input: largeLocal.snapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...input, input: largeShared.payload });
  await executionLoader.saveRegisteredSharedRecoveryExecutionPayload({
    ...input,
    input: largeExecution.payload,
  });
  expect(large.checkpoint.byteLength).toBeGreaterThan(65536);
  const saved = await saveRegisteredSharedRecoveryActionPayload({ ...input, input: large.payload });
  expect(await fs.readFile(saved.path)).toEqual(Buffer.from(JSON.stringify(large.payload)));
  expect((await loadRegisteredSharedRecoveryActionPayload(input)).payload).toEqual(large.payload);
});

it("serializes all four catalog removals across original action publication", async () => {
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
