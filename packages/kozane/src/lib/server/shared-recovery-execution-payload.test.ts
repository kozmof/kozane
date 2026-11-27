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
import {
  saveRegisteredSharedRecoveryExecutionPayload,
  loadRegisteredSharedRecoveryExecutionPayload,
  inspectRegisteredSharedRecoveryExecutionPayload,
} from "./shared-recovery-execution-payload.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
}));
vi.mock("./shared-recovery-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-payload.js")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof recovery.captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof recovery.describeSharedRecoveryHistory>>;
let executions: Awaited<ReturnType<typeof recovery.describeSharedRecoveryExecutions>>;
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
const directory = () => join(root, ".kozane", "recovery", "executions");
const published = () => join(directory(), `${executions.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${executions.checkpoint.sha256}.json`);
const sourcePath = (which: "local" | "shared") =>
  join(
    root,
    ".kozane",
    "recovery",
    which === "local" ? "checkpoints" : "shared-history",
    `${which === "local" ? local.checkpoint.sha256 : shared.checkpoint.sha256}.json`,
  );
const sourceTemporary = (which: "local" | "shared") =>
  join(
    root,
    ".kozane",
    "recovery",
    which === "local" ? "checkpoints" : "shared-history",
    `.pending-${which === "local" ? local.checkpoint.sha256 : shared.checkpoint.sha256}.json`,
  );
const bytes = () => Buffer.from(JSON.stringify(executions.payload), "utf8");
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  maxBytes: executions.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const save = () =>
  saveRegisteredSharedRecoveryExecutionPayload({ ...options(), input: executions.payload });
const load = () => loadRegisteredSharedRecoveryExecutionPayload(options());
const inspect = () => inspectRegisteredSharedRecoveryExecutionPayload(root, db, key);
const catalog = async () => ({
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
  root = await fs.mkdtemp(join(tmpdir(), "kozane-execution-payload-"));
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
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("publishes canonical execution bytes only after all expectations commit and leaves source files intact", async () => {
  const before = await catalog(),
    localBytes = await fs.readFile(sourcePath("local")),
    sharedBytes = await fs.readFile(sourcePath("shared"));
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT descriptor,local_descriptor FROM local_recovery_executions").get(),
      ).toMatchObject({
        descriptor: JSON.stringify(executions.checkpoint),
        local_descriptor: JSON.stringify(local.checkpoint),
      });
      expect(
        reader.prepare("SELECT descriptor FROM local_recovery_shared_history").get()?.descriptor,
      ).toBe(JSON.stringify(shared.checkpoint));
      expect(
        reader.prepare("SELECT descriptor FROM local_recovery_checkpoint").get()?.descriptor,
      ).toBe(JSON.stringify(local.checkpoint));
    } finally {
      reader.close();
    }
    expect(await fs.readFile(String(from))).toEqual(bytes());
    expect(existsSync(String(to))).toBe(false);
    return link(from, to);
  });
  expect(await save()).toEqual({
    path: published(),
    binding: { checkpoint: executions.checkpoint, localCheckpoint: local.checkpoint },
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
  expect(await fs.readFile(sourcePath("local"))).toEqual(localBytes);
  expect(await fs.readFile(sourcePath("shared"))).toEqual(sharedBytes);
  expect(await catalog()).toEqual(before);
  expect(existsSync(join(root, ".kozane", "assets"))).toBe(false);
});

it("inspects missing and orphaned execution evidence without creating directories or authorizing reads", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_checkpoint`);
  await db.run(sql`DELETE FROM local_recovery_shared_history`);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(save()).rejects.toThrow();
  await expect(load()).rejects.toThrow();
  expect(await fs.readFile(published())).toEqual(bytes());
});

it("reopens exact execution records from another connection without writes, handler dispatch or live installation", async () => {
  await save();
  const before = await catalog();
  const reopened = await openDb(`file:${join(root, "db.sqlite")}`),
    targets: Awaited<ReturnType<typeof factory>>[] = [];
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredSharedRecoveryExecutionPayload({
      ...options(),
      db: reopened.db,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    });
    expect(result).toEqual({
      payload: executions.payload,
      binding: { checkpoint: executions.checkpoint, localCheckpoint: local.checkpoint },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.effectSets[0].executions[1].input)).toBe(true);
    expect(result.payload.effectSets[1].executions).toHaveLength(1);
    expect(result.payload.effectSets[0].invocation.contractVersion).toBe(99);
  } finally {
    reopened.close();
  }
  expect(targets).toHaveLength(2);
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

it.each(["maxBytes", "localMaxBytes", "sharedMaxBytes"] as const)(
  "enforces independent %s limits before file reads or validation allocation",
  async (field) => {
    await save();
    const input = options();
    input[field]--;
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryExecutionPayload({ ...input, createValidationDatabase: create }),
    ).rejects.toThrow("exceeds read limit");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid byte limits %s before file opens",
  async (limit) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    for (const field of ["maxBytes", "localMaxBytes", "sharedMaxBytes"])
      await expect(
        loadRegisteredSharedRecoveryExecutionPayload({
          ...options(),
          [field]: limit,
          createValidationDatabase: create,
        }),
      ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it("requires the host's full checkpoint identity before reading files", async () => {
  await save();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  for (const field of ["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)
    await expect(
      loadRegisteredSharedRecoveryExecutionPayload({
        ...options(),
        expected: { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each(["executions", "shared", "local"])(
  "refuses missing %s expectations before file reads",
  async (which) => {
    await save();
    const table =
      which === "executions"
        ? "local_recovery_executions"
        : which === "shared"
          ? "local_recovery_shared_history"
          : "local_recovery_checkpoint";
    await db.run(sql.raw(`DELETE FROM ${table}`));
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryExecutionPayload({
        ...options(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["noop-input", "truncated-count", "unused-binding"])(
  "refuses changed %s before validation SQL or directory creation",
  async (change) => {
    const input = JSON.parse(JSON.stringify(executions.payload));
    if (change === "noop-input") {
      input.effectSets[1].invocation.input.ref = "changed";
      input.effectSets[1].executions[0].input.ref = "changed";
    }
    if (change === "truncated-count") {
      input.effectSets[0].executions.pop();
      input.selection.effectSets[0].executionCount--;
      input.effectSets[0].effects.forEach((effect: { actionId: string; executionOrd: number }) => {
        effect.actionId = "root";
        effect.executionOrd = 0;
      });
    }
    if (change === "unused-binding") input.effectSets[0].generated.unused.value = "changed";
    const create = vi.fn(factory);
    await expect(
      saveRegisteredSharedRecoveryExecutionPayload({
        ...options(),
        input,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("content mismatch");
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(directory())).toBe(false);
  },
);
it.each(["save", "load"] as const)(
  "%s checks exact source SQL values even when every canonical hash matches",
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
    // Inject coherent expectations and bytes that require actual SQL read-back to refuse.
    await db.run(
      sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(shared.checkpoint)}`,
    );
    await db.run(
      sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(executions.checkpoint)}`,
    );
    await fs.writeFile(sourcePath("shared"), JSON.stringify(shared.payload));
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
        ? saveRegisteredSharedRecoveryExecutionPayload({ ...input, input: executions.payload })
        : loadRegisteredSharedRecoveryExecutionPayload(input),
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

it("saves and reopens execution inputs larger than the fixed verification buffer", async () => {
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
  const groups = JSON.parse(JSON.stringify(executions.payload.effectSets));
  const selection = JSON.parse(JSON.stringify(executions.payload.selection));
  for (const group of groups) {
    group.invocation.id = `large-${group.invocation.id}`;
    for (const record of group.executions) {
      record.id = `large-${record.id}`;
      if (record.parentId !== null) record.parentId = `large-${record.parentId}`;
      for (const binding of Object.values(record.generated) as { type: string; value: string }[]) {
        if (binding.type === "child-id") binding.value = `large-${binding.value}`;
      }
    }
    for (const binding of Object.values(group.generated) as { type: string; value: string }[]) {
      if (binding.type === "child-id") binding.value = `large-${binding.value}`;
    }
    for (const effect of group.effects) effect.actionId = `large-${effect.actionId}`;
  }
  for (const selected of selection.effectSets) selected.rootId = `large-${selected.rootId}`;
  groups[0].invocation.input.text = "🪁".repeat(20000);
  groups[0].executions[0].input.text = groups[0].invocation.input.text;
  const large = await recovery.describeSharedRecoveryExecutions({
    checkpoint: largeShared.checkpoint,
    sharedHistory: largeShared.payload,
    selection,
    effectSets: groups,
  });
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, large.checkpoint);
  const input = {
    ...options(),
    expected,
    localMaxBytes: largeLocal.checkpoint.byteLength,
    sharedMaxBytes: largeShared.checkpoint.byteLength,
    maxBytes: large.checkpoint.byteLength,
  };
  await saveRegisteredLocalRecoveryPayload({ ...input, input: largeLocal.snapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...input, input: largeShared.payload });
  expect(large.checkpoint.byteLength).toBeGreaterThan(65536);
  const saved = await saveRegisteredSharedRecoveryExecutionPayload({
    ...input,
    input: large.payload,
  });
  expect(await fs.readFile(saved.path)).toEqual(Buffer.from(JSON.stringify(large.payload)));
  expect((await loadRegisteredSharedRecoveryExecutionPayload(input)).payload).toEqual(
    large.payload,
  );
});

it.each(["local", "shared"] as const)(
  "requires the saved %s source and preserves temporary evidence",
  async (source) => {
    await fs.rename(sourcePath(source), sourceTemporary(source));
    const before = await fs.readFile(sourceTemporary(source));
    await expect(save()).rejects.toThrow("needs review");
    expect(existsSync(directory())).toBe(false);
    expect(await fs.readFile(sourceTemporary(source))).toEqual(before);
  },
);
it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary execution evidence",
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
  "refuses an existing %s final path without replacing it",
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
it("refuses a symlinked execution directory without writing its target", async () => {
  await fs.mkdir(join(root, "outside"));
  await fs.symlink(join(root, "outside"), directory());
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await fs.readdir(join(root, "outside"))).toEqual([]);
});
it.each(["link", "unlink"] as const)(
  "preserves final and temporary evidence after %s failure",
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
  "preserves execution evidence after %s failure",
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
  "refuses %s execution bytes before source SQL validation",
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
      loadRegisteredSharedRecoveryExecutionPayload({
        ...options(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["utf8", "json", "noncanonical", "bom"])(
  "refuses hash-matching invalid %s before SQL allocation",
  async (state) => {
    const content =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(executions.payload))
            : Buffer.from(JSON.stringify(executions.payload, null, 2));
    const checkpoint = {
      ...executions.checkpoint,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
    await db.run(
      sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(checkpoint)}`,
    );
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryExecutionPayload({
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
  "execution-binding",
  "local-file",
  "local-temporary",
])("refuses %s changes while validating saved sources", async (change) => {
  await save();
  let calls = 0;
  await expect(
    loadRegisteredSharedRecoveryExecutionPayload({
      ...options(),
      createValidationDatabase: async () => {
        if (++calls === 2) {
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
          if (change === "execution-binding")
            await db.run(
              sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...executions.checkpoint, sha256: "b".repeat(64) })}`,
            );
          if (change === "local-file") await fs.writeFile(sourcePath("local"), "changed");
          if (change === "local-temporary") await fs.writeFile(sourceTemporary("local"), "partial");
        }
        return factory();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(2);
});
it.each(["local", "shared"] as const)(
  "keeps published execution evidence if the %s source changes during publication",
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
it("refuses coherent replacement of all bindings after execution validation", async () => {
  const require = recovery.requireSharedRecoveryExecutionCheckpoint;
  vi.spyOn(recovery, "requireSharedRecoveryExecutionCheckpoint").mockImplementationOnce(
    async (...args) => {
      const result = await require(...args),
        nextLocal = { ...local.checkpoint, sha256: "b".repeat(64) },
        nextShared = { ...shared.checkpoint, sha256: "c".repeat(64) };
      await withTx(db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(nextShared)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...executions.checkpoint, checkpoint: nextShared })},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
      });
      return result;
    },
  );
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});
it.each(["save", "load"])(
  "owns payloads, identity, root and limits during %s callbacks",
  async (mode) => {
    if (mode === "load") await save();
    const input = {
      ...options(),
      input: JSON.parse(JSON.stringify(executions.payload)),
      expected: { ...identity },
    };
    input.createValidationDatabase = async () => {
      input.input.effectSets.length = 0;
      input.expected.deviceId = "changed";
      input.root = join(root, "elsewhere");
      input.localMaxBytes = 0;
      input.sharedMaxBytes = 0;
      return factory();
    };
    if (mode === "save") await saveRegisteredSharedRecoveryExecutionPayload(input);
    else
      expect((await loadRegisteredSharedRecoveryExecutionPayload(input)).payload).toEqual(
        executions.payload,
      );
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it.each(["save", "load"])(
  "preserves earlier evidence when the final %s commit fails",
  async (mode) => {
    if (mode === "load") await save();
    let ready = false;
    const original = sharedLoader.loadRegisteredSharedRecoveryPayload;
    vi.spyOn(sharedLoader, "loadRegisteredSharedRecoveryPayload").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
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
        saveRegisteredSharedRecoveryExecutionPayload({
          ...options(),
          input: executions.payload,
          db: wrapped,
        }),
      ).rejects.toThrow();
    else
      await expect(
        loadRegisteredSharedRecoveryExecutionPayload({ ...options(), db: wrapped }),
      ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);
it("serializes all source catalog removals across execution publication", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return link(...args);
  });
  const saving = save();
  try {
    await entered.promise;
    for (const table of [
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
