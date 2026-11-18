import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrations } from "@kozane/core/migrations";
import {
  captureLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpoint,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import {
  saveRegisteredLocalRecoveryPayload,
  loadRegisteredLocalRecoveryPayload,
} from "./local-recovery-payload.js";
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let captured: Awaited<ReturnType<typeof captureLocalRecoveryCheckpoint>>;
const identity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const factory = () => createTestDB();
const directory = () => join(root, ".kozane", "recovery", "checkpoints");
const published = () => join(directory(), `${captured.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${captured.checkpoint.sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(captured.snapshot), "utf8");
const load = (maxBytes = captured.checkpoint.byteLength, createValidationDatabase = factory) =>
  loadRegisteredLocalRecoveryPayload({
    root,
    db,
    expected: identity,
    maxBytes,
    createValidationDatabase,
  });
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-recovery-load-"));
  db = await createTestDB(join(root, "db.sqlite"));
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/🪁' || char(0) || 'file','workspace_relative',9007199254740993)`,
  );
  captured = await captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: [],
  }));
  await rememberLocalRecoveryCheckpoint(db, captured.checkpoint);
  await saveRegisteredLocalRecoveryPayload({
    root,
    db,
    input: captured.snapshot,
    expected: identity,
    createValidationDatabase: factory,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("reopens and validates published bytes without filesystem writes or record changes", async () => {
  const reopened = await openDb(`file:${join(root, "db.sqlite")}`);
  const before = await db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
  );
  const mkdir = vi.spyOn(fs, "mkdir");
  const link = vi.spyOn(fs, "link");
  const unlink = vi.spyOn(fs, "unlink");
  const open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredLocalRecoveryPayload({
      root,
      db: reopened.db,
      expected: identity,
      maxBytes: captured.checkpoint.byteLength,
      createValidationDatabase: factory,
    });
    expect(result).toEqual(captured);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.snapshot.tables[0])).toBe(true);
  } finally {
    reopened.close();
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
  expect(await fs.readFile(published())).toEqual(bytes());
  expect(
    await db.values(sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`),
  ).toEqual(before);
});

it("loads exact Unicode values across multiple read buffers", async () => {
  await db.run(sql`UPDATE taskspace_local SET path=${"🪁\0".repeat(20000)}`);
  const expected = { ...identity, checkpointId: "large" };
  const large = await captureLocalRecoveryCheckpoint(db, expected, async () => ({
    baselineId: "baseline",
    effectSetIds: [],
  }));
  await rememberLocalRecoveryCheckpoint(db, large.checkpoint);
  await saveRegisteredLocalRecoveryPayload({
    root,
    db,
    input: large.snapshot,
    expected,
    createValidationDatabase: factory,
  });
  expect(large.checkpoint.byteLength).toBeGreaterThan(65536);
  await expect(
    loadRegisteredLocalRecoveryPayload({
      root,
      db,
      expected,
      maxBytes: large.checkpoint.byteLength,
      createValidationDatabase: factory,
    }),
  ).resolves.toEqual(large);
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid input size limit %s before file access",
  async (limit) => {
    const open = vi.spyOn(fs, "open");
    const create = vi.fn(factory);
    await expect(load(limit, create)).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it("refuses a registered length above the host limit before opening the file", async () => {
  const open = vi.spyOn(fs, "open");
  const create = vi.fn(factory);
  await expect(load(captured.checkpoint.byteLength - 1, create)).rejects.toThrow(
    "exceeds read limit",
  );
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it.each(["temporary-only", "both"])("never loads or removes %s evidence", async (state) => {
  if (state === "temporary-only") await fs.rename(published(), temporary());
  else await fs.writeFile(temporary(), bytes());
  const open = vi.spyOn(fs, "open");
  const unlink = vi.spyOn(fs, "unlink");
  await expect(load()).rejects.toThrow("needs review");
  expect(open).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(await fs.readFile(temporary())).toEqual(bytes());
});

it.each(["missing", "corrupt", "symlink", "unsafe-parent"] as const)(
  "refuses %s published data before allocating a validation database",
  async (state) => {
    if (state === "missing") await fs.unlink(published());
    if (state === "corrupt") await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    if (state === "symlink") {
      const outside = join(root, "outside.json");
      await fs.rename(published(), outside);
      await fs.symlink(outside, published());
    }
    if (state === "unsafe-parent") {
      const outside = join(root, "outside");
      await fs.rename(join(root, ".kozane", "recovery"), outside);
      await fs.symlink(outside, join(root, ".kozane", "recovery"));
    }
    const create = vi.fn(factory);
    await expect(load(captured.checkpoint.byteLength, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it("refuses missing or mismatched catalog expectations before payload reads", async () => {
  const open = vi.spyOn(fs, "open");
  await expect(
    loadRegisteredLocalRecoveryPayload({
      root,
      db,
      expected: { ...identity, deviceId: "other" },
      maxBytes: 100000,
      createValidationDatabase: factory,
    }),
  ).rejects.toThrow("not registered");
  await db.run(sql`DELETE FROM local_recovery_checkpoint`);
  await expect(load()).rejects.toThrow("not registered");
  expect(open).not.toHaveBeenCalled();
});

async function replaceRegisteredBytes(content: Buffer) {
  const descriptor = {
    ...captured.checkpoint,
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  await db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(descriptor)}`);
  await fs.writeFile(join(directory(), `${descriptor.sha256}.json`), content);
}
it.each(["invalid-utf8", "invalid-json", "noncanonical-json"] as const)(
  "refuses hash-matching %s without SQL allocation",
  async (state) => {
    const content =
      state === "invalid-utf8"
        ? Buffer.from([255, 254, 128])
        : state === "invalid-json"
          ? Buffer.from("{invalid")
          : Buffer.from(JSON.stringify(captured.snapshot, null, 2));
    await replaceRegisteredBytes(content);
    const create = vi.fn(factory);
    await expect(load(100000, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it("still rejects SQL affinity changes after a raw content hash matches", async () => {
  const snapshot = JSON.parse(JSON.stringify(captured.snapshot));
  snapshot.tables.find(
    (table: { name: string }) => table.name === "taskspace_local",
  ).rows[0].last_seen_at = ["real", "3ff0000000000000"];
  await replaceRegisteredBytes(Buffer.from(JSON.stringify(snapshot)));
  const target = await createTestDB();
  const create = vi.fn(async () => target);
  await expect(load(100000, create)).rejects.toThrow("differs from projection");
  expect(create).toHaveBeenCalledTimes(1);
  expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
});

it.each(["removed", "rewritten", "replaced", "new-temporary", "catalog-replaced"] as const)(
  "refuses %s artifacts during isolated validation",
  async (change) => {
    const target = await createTestDB();
    const create = vi.fn(async () => {
      if (change === "removed") await fs.unlink(published());
      if (change === "rewritten") {
        await fs.writeFile(published(), bytes());
        await fs.utimes(published(), new Date(2000), new Date(2000));
      }
      if (change === "replaced") {
        const replacement = join(directory(), "replacement.json");
        await fs.writeFile(replacement, bytes());
        await fs.rename(replacement, published());
      }
      if (change === "new-temporary") await fs.writeFile(temporary(), bytes());
      if (change === "catalog-replaced")
        await db.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...captured.checkpoint, sha256: "b".repeat(64) })}`,
        );
      return target;
    });
    await expect(load(captured.checkpoint.byteLength, create)).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
  },
);

it("allows later checkpoint registration while SQL validation runs outside the catalog lock", async () => {
  const result = await load(captured.checkpoint.byteLength, async () => {
    const later = await captureLocalRecoveryCheckpoint(
      db,
      { ...identity, checkpointId: "later" },
      async () => captured.checkpoint.selection,
    );
    await rememberLocalRecoveryCheckpoint(db, later.checkpoint);
    return createTestDB();
  });
  expect(result).toEqual(captured);
  expect(existsSync(published())).toBe(true);
});

it("detects growth during bounded reads without parsing truncated bytes", async () => {
  const open = fs.open;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementationOnce(
      async (...readArgs: Parameters<typeof read>) => {
        await fs.appendFile(published(), "extra");
        return read(...readArgs);
      },
    );
    return handle;
  });
  const create = vi.fn(factory);
  await expect(load(captured.checkpoint.byteLength, create)).rejects.toThrow("different-content");
  expect(create).not.toHaveBeenCalled();
});
