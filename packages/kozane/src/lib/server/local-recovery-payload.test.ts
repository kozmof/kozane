import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabaseAdapter, type DatabaseHandle } from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import {
  captureLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpoint,
  requireLocalRecoveryCheckpoint,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { withTx, withReadTx } from "../../db/database.js";
import {
  inspectRegisteredLocalRecoveryPayload,
  saveRegisteredLocalRecoveryPayload,
} from "./local-recovery-payload.js";
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let captured: Awaited<ReturnType<typeof captureLocalRecoveryCheckpoint>>;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-recovery-payload-"));
  db = await createTestDB(join(root, "db.sqlite"));
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/🪁','workspace_relative',9007199254740993)`,
  );
  captured = await captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: [],
  }));
  await rememberLocalRecoveryCheckpoint(db, captured.checkpoint);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});
const directory = () => join(root, ".kozane", "recovery", "checkpoints");
const published = () => join(directory(), `${captured.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${captured.checkpoint.sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(captured.snapshot), "utf8");
const factory = () => createTestDB();
const save = (input: unknown = captured.snapshot) =>
  saveRegisteredLocalRecoveryPayload({
    root,
    db,
    input,
    expected: identity,
    createValidationDatabase: factory,
  });
const inspect = () => inspectRegisteredLocalRecoveryPayload(root, db, key);
const catalog = () =>
  db.values(sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`);

it("publishes canonical synced bytes only after finding a committed descriptor and is idempotent", async () => {
  const before = await catalog();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT descriptor FROM local_recovery_checkpoint").get()?.descriptor,
      ).toBe(JSON.stringify(captured.checkpoint));
    } finally {
      reader.close();
    }
    expect(await fs.readFile(String(from))).toEqual(bytes());
    expect(existsSync(String(to))).toBe(false);
    return link(from, to);
  });
  const result = await save();
  expect(result.changed).toBe(true);
  expect(await fs.realpath(result.path)).toBe(await fs.realpath(published()));
  expect(await fs.readFile(published())).toEqual(bytes());
  if (process.platform !== "win32") expect((await fs.stat(published())).mode & 0o777).toBe(0o600);
  expect(existsSync(temporary())).toBe(false);
  expect(
    await requireLocalRecoveryCheckpoint(
      JSON.parse(await fs.readFile(published(), "utf8")),
      captured.checkpoint,
    ),
  ).toEqual(captured.snapshot);
  expect((await save()).changed).toBe(false);
  expect(fs.link).toHaveBeenCalledTimes(1);
  expect(await catalog()).toEqual(before);
});

it("inspects missing and published payloads without creating directories or changing files", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  expect(existsSync(join(root, ".kozane"))).toBe(false);
  await save();
  mkdir.mockClear();
  const before = await fs.readFile(published());
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  expect(await fs.readFile(published())).toEqual(before);
});

it.each(["missing", "changed-payload", "changed-during-validation"] as const)(
  "refuses %s expectations before payload directory creation",
  async (change) => {
    const input = JSON.parse(JSON.stringify(captured.snapshot));
    if (change === "missing") await db.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "changed-payload")
      input.tables.find(
        (table: { name: string }) => table.name === "taskspace_local",
      ).rows[0].path = ["text", "other"];
    const createValidationDatabase = vi.fn(async () => {
      if (change === "changed-during-validation")
        await db.run(sql`DELETE FROM local_recovery_checkpoint`);
      return createTestDB();
    });
    await expect(
      saveRegisteredLocalRecoveryPayload({
        root,
        db,
        input,
        expected: identity,
        createValidationDatabase,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(root, ".kozane"))).toBe(false);
  },
);

it.each(["matching", "partial", "symlink"] as const)(
  "preserves %s temporary evidence without publishing or retrying it",
  async (kind) => {
    await fs.mkdir(directory(), { recursive: true });
    const outside = join(root, "outside");
    await fs.writeFile(outside, bytes());
    if (kind === "symlink") await fs.symlink(outside, temporary());
    else await fs.writeFile(temporary(), kind === "matching" ? bytes() : Buffer.from("{partial"));
    const before = await catalog();
    const link = vi.spyOn(fs, "link");
    const unlink = vi.spyOn(fs, "unlink");
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: "absent",
      temporary:
        kind === "matching"
          ? "matching-content"
          : kind === "symlink"
            ? "unsafe-path"
            : "different-content",
    });
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(await fs.readFile(outside)).toEqual(bytes());
    expect(await catalog()).toEqual(before);
  },
);

it.each(["corrupt", "symlink", "directory"] as const)(
  "refuses an existing %s destination without overwriting it",
  async (kind) => {
    await fs.mkdir(directory(), { recursive: true });
    const outside = join(root, "outside");
    await fs.writeFile(outside, bytes());
    if (kind === "symlink") await fs.symlink(outside, published());
    else if (kind === "directory") await fs.mkdir(published());
    else await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    const link = vi.spyOn(fs, "link");
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: kind === "symlink" ? "unsafe-path" : "different-content",
      temporary: "absent",
    });
    expect(link).not.toHaveBeenCalled();
    expect(await fs.readFile(outside)).toEqual(bytes());
    expect(existsSync(temporary())).toBe(false);
  },
);

it("refuses symlinked parent directories without reading or writing their targets", async () => {
  const outside = join(root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(join(root, ".kozane"));
  await fs.symlink(outside, join(root, ".kozane", "recovery"));
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await inspect()).toMatchObject({ published: "unsafe-path", temporary: "unsafe-path" });
  expect(await fs.readdir(outside)).toEqual([]);
});

it("retains a complete temporary payload after link failure and does not automatically retry publication", async () => {
  const link = vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("Link failed"));
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "matching-content" });
  await expect(save()).rejects.toThrow();
  expect(link).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(temporary())).toEqual(bytes());
});

it("preserves both names after temporary unlink failure for read-only review", async () => {
  const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Unlink failed"));
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await inspect()).toMatchObject({
    published: "matching-content",
    temporary: "matching-content",
  });
  await expect(save()).rejects.toThrow();
  expect(unlink).toHaveBeenCalledTimes(1);
});

it.each(["partial-write", "file-sync", "directory-sync"] as const)(
  "retains evidence after %s fails",
  async (failure) => {
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
            await write("{partial");
            throw new Error("Write failed");
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

it("keeps published bytes and the original descriptor after an outer commit failure", async () => {
  const before = await catalog();
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
  await expect(
    saveRegisteredLocalRecoveryPayload({
      root,
      db: wrapped,
      input: captured.snapshot,
      expected: identity,
      createValidationDatabase: factory,
    }),
  ).rejects.toThrow();
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  expect(await catalog()).toEqual(before);
  expect((await save()).changed).toBe(false);
});

it("holds the catalog writer lock across publication and refuses competing removal", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  await other.db.values(sql`PRAGMA busy_timeout=1`);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    entered.resolve();
    await proceed.promise;
    return link(from, to);
  });
  const pending = save();
  void pending.catch(() => {});
  try {
    await entered.promise;
    await expect(
      withTx(other.db, (tx) => tx.run(sql`DELETE FROM local_recovery_checkpoint`)),
    ).rejects.toThrow();
  } finally {
    proceed.resolve();
    await pending;
    other.close();
  }
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
});
