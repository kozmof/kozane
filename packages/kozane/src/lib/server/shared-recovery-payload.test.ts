import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import {
  saveRegisteredSharedRecoveryPayload,
  inspectRegisteredSharedRecoveryPayload,
} from "./shared-recovery-payload.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof recovery.captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof recovery.describeSharedRecoveryHistory>>;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const selection = {
  baselineId: "baseline",
  effectSets: [
    { id: "edit", effectCount: 1 },
    { id: "empty", effectCount: 0 },
  ],
};
const namespace = (name: string) => ({
  id: ["text", "n"] as const,
  name: ["text", name] as const,
  is_default: ["integer", "0"] as const,
});
const finalName = "\ufefffinal\0🪁";
function history(initial = "start") {
  return {
    baseline: {
      id: "baseline",
      projection: recovery.parseSharedRecoveryProjection({
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
        ].map((name) => ({ name, rows: name === "namespace" ? [namespace(initial)] : [] })),
      }),
    },
    effectSets: [
      {
        id: "edit",
        effects: [
          {
            ord: 0,
            table: "namespace",
            key: { id: ["text", "n"] as const },
            op: "U" as const,
            before: namespace(initial),
            after: namespace(finalName),
          },
        ],
      },
      { id: "empty", effects: [] },
    ],
  };
}
const factory = () => createTestDB();
const directory = () => join(root, ".kozane", "recovery", "shared-history");
const published = () => join(directory(), `${shared.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${shared.checkpoint.sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(shared.payload), "utf8");
const options = () => ({
  root,
  db,
  input: shared.payload,
  expected: identity,
  createValidationDatabase: factory,
});
const save = () => saveRegisteredSharedRecoveryPayload(options());
const inspect = () => inspectRegisteredSharedRecoveryPayload(root, db, key);
const catalog = async () => ({
  local: await db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
  ),
  shared: await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
  ),
});
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-shared-payload-"));
  db = await createTestDB(join(root, "db.sqlite"));
  await db.run(sql`INSERT INTO namespace(id,name) VALUES('n',${finalName})`);
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','device-only','workspace_relative',9007199254740993)`,
  );
  local = await recovery.captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  shared = await recovery.describeSharedRecoveryHistory(history(), identity, selection);
  await recovery.rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("publishes canonical synced shared bytes only after both descriptor expectations commit and is idempotent", async () => {
  const before = await catalog();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      expect(
        reader
          .prepare("SELECT descriptor,local_descriptor FROM local_recovery_shared_history")
          .get(),
      ).toMatchObject({
        descriptor: JSON.stringify(shared.checkpoint),
        local_descriptor: JSON.stringify(local.checkpoint),
      });
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
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    changed: true,
  });
  expect(await fs.readFile(published())).toEqual(bytes());
  if (process.platform !== "win32") expect((await fs.stat(published())).mode & 0o777).toBe(0o600);
  expect(existsSync(temporary())).toBe(false);
  const beforeStat = await fs.stat(published(), { bigint: true });
  expect((await save()).changed).toBe(false);
  expect(await fs.stat(published(), { bigint: true })).toMatchObject({
    ino: beforeStat.ino,
    mtimeNs: beforeStat.mtimeNs,
  });
  expect(await catalog()).toEqual(before);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
});

it("keeps shared payloads separate from the matching local snapshot file", async () => {
  const savedLocal = await saveRegisteredLocalRecoveryPayload({
    ...options(),
    input: local.snapshot,
  });
  const localBytes = await fs.readFile(savedLocal.path);
  const savedShared = await save();
  expect(savedLocal.path).not.toBe(savedShared.path);
  expect(savedLocal.path).toContain(join("recovery", "checkpoints"));
  expect(savedShared.path).toContain(join("recovery", "shared-history"));
  expect(await fs.readFile(savedLocal.path)).toEqual(localBytes);
  expect(await fs.readFile(savedShared.path)).toEqual(bytes());
});

it("inspects missing or orphaned payload evidence without creating directories or changing bindings", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_checkpoint`);
  const before = await fs.readFile(published());
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(save()).rejects.toThrow("binding changed");
  expect(await fs.readFile(published())).toEqual(before);
});

it.each(["missing-shared", "missing-local", "changed-local", "changed-payload"])(
  "refuses %s before validation allocation and disk work",
  async (change) => {
    const input = JSON.parse(JSON.stringify(shared.payload));
    if (change === "missing-shared") await db.run(sql`DELETE FROM local_recovery_shared_history`);
    if (change === "missing-local") await db.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "changed-local")
      await db.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "changed-payload")
      input.history.effectSets[0].effects[0].after.name = ["text", "changed"];
    const create = vi.fn(factory);
    await expect(
      saveRegisteredSharedRecoveryPayload({
        ...options(),
        input,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(directory())).toBe(false);
  },
);

it.each(["shared", "local"])(
  "refuses a changed %s catalog record during isolated SQL validation",
  async (change) => {
    const create = async () => {
      if (change === "shared") await db.run(sql`DELETE FROM local_recovery_shared_history`);
      else await db.run(sql`DELETE FROM local_recovery_checkpoint`);
      return factory();
    };
    await expect(
      saveRegisteredSharedRecoveryPayload({ ...options(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(existsSync(directory())).toBe(false);
  },
);

it("retains the original pair across the gap between SQL validation and filesystem publication", async () => {
  const validate = recovery.validateStoredSharedRecoveryCheckpoint;
  vi.spyOn(recovery, "validateStoredSharedRecoveryCheckpoint").mockImplementationOnce(
    async (...args) => {
      const result = await validate(...args);
      const replaced = JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) });
      await db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${replaced}`);
      await db.run(sql`UPDATE local_recovery_shared_history SET local_descriptor=${replaced}`);
      return result;
    },
  );
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});

it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary evidence without publishing or removing it",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), temporary());
    } else
      await fs.writeFile(temporary(), state === "matching" ? bytes() : Buffer.from("{partial"));
    const link = vi.spyOn(fs, "link");
    const unlink = vi.spyOn(fs, "unlink");
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

it.each(["different", "symlink", "directory"])(
  "refuses an existing %s final path without creating temporary bytes",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "directory") await fs.mkdir(published());
    if (state === "different") await fs.writeFile(published(), "different");
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), published());
    }
    const link = vi.spyOn(fs, "link");
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(link).not.toHaveBeenCalled();
    expect(existsSync(temporary())).toBe(false);
    expect(await inspect()).toMatchObject({
      published: state === "symlink" ? "unsafe-path" : "different-content",
      temporary: "absent",
    });
  },
);

it("refuses symlinked parent directories without writing their targets", async () => {
  await fs.mkdir(join(root, ".kozane"));
  await fs.mkdir(join(root, "outside"));
  await fs.symlink(join(root, "outside"), join(root, ".kozane", "recovery"));
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await inspect()).toMatchObject({ published: "unsafe-path", temporary: "unsafe-path" });
  expect(await fs.readdir(join(root, "outside"))).toEqual([]);
});

it.each(["link", "unlink"] as const)(
  "preserves published and temporary evidence after %s failure",
  async (failure) => {
    vi.spyOn(fs, failure).mockRejectedValueOnce(new Error("Publication failed"));
    const before = await catalog();
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: failure === "link" ? "absent" : "matching-content",
      temporary: "matching-content",
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await fs.readFile(temporary())).toEqual(bytes());
    expect(await catalog()).toEqual(before);
  },
);

it.each(["partial-write", "file-sync", "directory-sync"])(
  "preserves shared payload evidence after %s failure",
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
    const before = await catalog();
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
    expect(await catalog()).toEqual(before);
    if (failure === "directory-sync") expect((await save()).changed).toBe(false);
  },
);

it("preserves both files after a competing final entry appears during exclusive publication", async () => {
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    await fs.writeFile(published(), "competing bytes");
    return link(...args);
  });
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await fs.readFile(published(), "utf8")).toBe("competing bytes");
  expect(await fs.readFile(temporary())).toEqual(bytes());
});

it("keeps original bindings and published bytes after an outer commit failure", async () => {
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    read: (operation) => withReadTx(db, (tx) => operation(tx as unknown as DatabaseHandle)),
    write: (operation) =>
      withTx(db, async (tx) => {
        const result = await operation(tx);
        await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
        await tx.run(
          sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
        );
        await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
        return result;
      }),
  });
  const before = await catalog();
  await expect(
    saveRegisteredSharedRecoveryPayload({ ...options(), db: wrapped }),
  ).rejects.toThrow();
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  expect(await catalog()).toEqual(before);
  expect((await save()).changed).toBe(false);
});

it("serializes shared and local catalog deletion across publication", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return link(...args);
  });
  const saving = save();
  try {
    await entered.promise;
    for (const table of ["local_recovery_shared_history", "local_recovery_checkpoint"]) {
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

it("owns payload and context before validation callbacks can mutate caller data", async () => {
  const input = JSON.parse(JSON.stringify(shared.payload));
  const expected = { ...identity };
  await saveRegisteredSharedRecoveryPayload({
    ...options(),
    input,
    expected,
    createValidationDatabase: async () => {
      input.history.effectSets.length = 0;
      expected.deviceId = "changed";
      return factory();
    },
  });
  expect(await fs.readFile(published())).toEqual(bytes());
});

it("publishes and inspects shared history larger than the fixed verification buffer", async () => {
  const largeIdentity = { ...identity, checkpointId: "large" };
  const largeLocal = await recovery.captureLocalRecoveryCheckpoint(db, largeIdentity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, largeLocal.checkpoint);
  const large = await recovery.describeSharedRecoveryHistory(
    history("🪁".repeat(20000)),
    largeIdentity,
    selection,
  );
  await recovery.rememberSharedRecoveryCheckpoint(db, large.checkpoint);
  expect(large.checkpoint.byteLength).toBeGreaterThan(65536);
  const saved = await saveRegisteredSharedRecoveryPayload({
    ...options(),
    input: large.payload,
    expected: largeIdentity,
  });
  expect(await fs.readFile(saved.path)).toEqual(Buffer.from(JSON.stringify(large.payload)));
  expect(
    await inspectRegisteredSharedRecoveryPayload(root, db, { ...key, checkpointId: "large" }),
  ).toMatchObject({ published: "matching-content", temporary: "absent" });
});
