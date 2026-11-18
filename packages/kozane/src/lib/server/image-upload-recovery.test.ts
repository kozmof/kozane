import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { databaseFailureKind } from "../../db/failures.js";
import { createNamespace } from "../../db/api/namespace.js";
import { cardTable, layerTable, partitionTable, localImageUploadTable } from "../../db/schema.js";
import { captureApplicationRows } from "../../test-utils/action-tables.js";
import type { DB as CoreDB } from "../../../../core/src/database.js";
import {
  storeImage,
  imageDirectory,
  collectUnusedImages,
  retryImageDeletions,
} from "./image-assets.js";
import { inspectImageUpload } from "./image-upload-evidence.js";
import {
  abandonImageUpload,
  listImageUploads,
  pendingImageUploads,
  recoverImageUpload,
} from "./image-upload-recovery.js";
import { createLocalClaimStartupCheck } from "./local-claim-startup.js";
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let db: Awaited<ReturnType<typeof createTestDB>>;
let root: string;
const source = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const bytes = new TextEncoder().encode(source);
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kozane-recover-upload-"));
  db = await createTestDB(join(root, "db.sqlite"));
  await createNamespace({ db, name: "Main" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const rows = () => db.select().from(localImageUploadTable);
// The source fixtures and packaged host types describe the same runtime adapter.
const shared = () => captureApplicationRows(db as unknown as CoreDB);
const store = () => storeImage(root, db, "image.svg", bytes);
const recover = (filename: string, apply = false) => recoverImageUpload(db, root, filename, apply);
const abandon = (filename: string, apply = false, reason = "Reviewed unused upload") =>
  abandonImageUpload(db, filename, reason, apply);
const path = (filename: string) => join(imageDirectory(root), filename);
async function interrupted() {
  await db.run(
    sql`CREATE TRIGGER reject_install BEFORE UPDATE ON local_image_upload WHEN NEW.state='installed' BEGIN SELECT RAISE(ABORT,'interrupted'); END`,
  );
  await expect(store()).rejects.toThrow("needs review");
  await db.run(sql`DROP TRIGGER reject_install`);
  const [row] = await rows();
  expect(row).toMatchObject({ state: "pending", error: null });
  return row;
}
async function reference(filename: string) {
  const [layer] = await db.select().from(layerTable);
  const [partition] = await db.select().from(partitionTable);
  await db.insert(cardTable).values({
    id: "linked",
    layerId: layer.id,
    partitionId: partition.id,
    content: "kozane-image:/api/images/" + filename,
  });
}

it("previews read-only, confirms installed bytes without changing files, and keeps an unreferenced pin", async () => {
  const pending = await interrupted();
  const before = await shared();
  const changes = [
    vi.spyOn(fs, "mkdir"),
    vi.spyOn(fs, "writeFile"),
    vi.spyOn(fs, "link"),
    vi.spyOn(fs, "unlink"),
    vi.spyOn(fs, "rename"),
    vi.spyOn(fs, "rm"),
  ];
  const opens = vi.spyOn(fs, "open");
  expect(await recover(pending.filename)).toMatchObject({ status: "confirmable", linked: false });
  expect(await rows()).toEqual([pending]);
  expect(await recover(pending.filename, true)).toMatchObject({
    status: "confirmed",
    upload: { state: "installed", createdAt: pending.createdAt, installedAt: expect.any(Date) },
  });
  const installed = await rows();
  expect(await recover(pending.filename, true)).toMatchObject({ status: "already-installed" });
  expect(await rows()).toEqual(installed);
  expect(await shared()).toEqual(before);
  expect(await fs.readFile(path(pending.filename), "utf8")).toBe(source);
  changes.forEach((change) => expect(change).not.toHaveBeenCalled());
  for (const [, flags] of opens.mock.calls)
    expect(Number(flags) & (constants.O_CREAT | constants.O_WRONLY | constants.O_RDWR)).toBe(0);
});

it.each([false, true])(
  "completes only the verified upload when a card already references it (installed=%s)",
  async (installed) => {
    const pending = installed ? (await store(), (await rows())[0]) : await interrupted();
    await reference(pending.filename);
    const other = {
      ...pending,
      filename: "00000000-0000-4000-8000-000000000001.svg",
      state: "installed" as const,
      installedAt: new Date(1000),
    };
    await db.insert(localImageUploadTable).values(other);
    const before = await shared();
    const result = await recover(pending.filename, true);
    expect(result).toMatchObject({
      status: "confirmed",
      linked: true,
      upload: {
        state: "completed",
        installedAt: pending.installedAt ?? expect.any(Date),
        completedAt: expect.any(Date),
      },
    });
    expect((await rows()).find((row) => row.filename === other.filename)).toEqual(other);
    expect(await shared()).toEqual(before);
    const completed = await rows();
    await fs.rm(path(pending.filename));
    expect((await recover(pending.filename, true)).status).toBe("already-completed");
    expect(await rows()).toEqual(completed);
    await expect(abandon(pending.filename, true)).rejects.toThrow("Completed image uploads");
  },
);

it.each([
  "missing",
  "different",
  "temporary-only",
  "both-present",
  "file-symlink",
  "parent-symlink",
  "temporary-symlink",
  "directory",
  "recorded-error",
  "timestamp",
] as const)("refuses %s evidence while retaining metadata and shared rows", async (failure) => {
  const pending = await interrupted();
  const published = path(pending.filename);
  const temporary = path(`.upload-${pending.filename}`);
  if (failure === "missing") await fs.rm(published);
  if (failure === "different") await fs.writeFile(published, "Different bytes");
  if (failure === "temporary-only") await fs.rename(published, temporary);
  if (failure === "both-present") await fs.link(published, temporary);
  if (failure === "file-symlink") {
    await fs.rename(published, join(root, "kept"));
    await fs.symlink(join(root, "kept"), published);
  }
  if (failure === "parent-symlink") {
    await fs.rename(imageDirectory(root), join(root, "kept"));
    await fs.symlink(join(root, "kept"), imageDirectory(root));
  }
  if (failure === "temporary-symlink") await fs.symlink(published, temporary);
  if (failure === "directory") {
    await fs.rm(published);
    await fs.mkdir(published);
  }
  if (failure === "recorded-error")
    await db.update(localImageUploadTable).set({ error: "Partial publication" });
  if (failure === "timestamp")
    await db.run(sql`UPDATE local_image_upload SET created_at=8640000000001`);
  const evidence = await rows();
  const before = await shared();
  expect((await recover(pending.filename)).status).toBe("blocked");
  await expect(recover(pending.filename, true)).rejects.toThrow("cannot be recovered");
  expect(await rows()).toEqual(evidence);
  expect(await shared()).toEqual(before);
});

it.each([false, true])(
  "retains pending evidence when recovery cannot confirm (commit=%s)",
  async (commit) => {
    const pending = await interrupted();
    await reference(pending.filename);
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_recovery AFTER UPDATE ON local_image_upload BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_recovery BEFORE UPDATE ON local_image_upload BEGIN SELECT RAISE(IGNORE); END`,
      );
    const before = await shared();
    await expect(recover(pending.filename, true)).rejects.toThrow();
    expect(await rows()).toEqual([pending]);
    expect(await shared()).toEqual(before);
    expect(await fs.readFile(path(pending.filename), "utf8")).toBe(source);
    await db.run(sql`DROP TRIGGER reject_recovery`);
    expect((await recover(pending.filename, true)).upload.state).toBe("completed");
  },
);

it("rechecks bytes after preview and safely resolves competing confirmations", async () => {
  const pending = await interrupted();
  expect((await recover(pending.filename)).status).toBe("confirmable");
  await fs.writeFile(path(pending.filename), "Later bytes");
  await expect(recover(pending.filename, true)).rejects.toThrow("different-content");
  expect(await rows()).toEqual([pending]);
  await fs.writeFile(path(pending.filename), bytes);
  const results = await Promise.allSettled([
    recover(pending.filename, true),
    recover(pending.filename, true),
  ]);
  expect(
    results.some((result) => result.status === "fulfilled" && result.value.status === "confirmed"),
  ).toBe(true);
  for (const result of results)
    if (result.status === "rejected") expect(databaseFailureKind(result.reason)).toBe("transient");
  expect((await recover(pending.filename, true)).status).toBe("already-installed");
});

it("previews abandonment and retains immutable intent, errors, reason and decision time", async () => {
  const pending = await interrupted();
  await db.update(localImageUploadTable).set({ error: "Original filesystem failure" });
  const [original] = await rows();
  const before = await shared();
  expect((await abandon(pending.filename)).changed).toBe(false);
  expect(await rows()).toEqual([original]);
  expect((await abandon(pending.filename, true)).changed).toBe(true);
  const recorded = await rows();
  expect(recorded[0]).toMatchObject({
    ...original,
    state: "abandoned",
    abandonedAt: expect.any(Date),
    abandonReason: "Reviewed unused upload",
  });
  expect((await abandon(pending.filename, true)).changed).toBe(false);
  expect(await rows()).toEqual(recorded);
  await expect(abandon(pending.filename, true, "Different decision")).rejects.toThrow(
    "another reason",
  );
  await expect(recover(pending.filename, true)).rejects.toThrow("abandoned");
  expect(await shared()).toEqual(before);
  expect(await fs.readFile(path(pending.filename), "utf8")).toBe(source);
});

it.each([false, true])("keeps a pin when abandonment fails (commit=%s)", async (commit) => {
  const pending = await interrupted();
  if (commit) {
    await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
    await db.run(
      sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    await db.run(
      sql`CREATE TRIGGER reject_abandon AFTER UPDATE ON local_image_upload BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
    );
  } else
    await db.run(
      sql`CREATE TRIGGER reject_abandon BEFORE UPDATE ON local_image_upload BEGIN SELECT RAISE(ABORT,'abandonment refused'); END`,
    );
  await expect(abandon(pending.filename, true)).rejects.toThrow();
  expect(await rows()).toEqual([pending]);
  await fs.utimes(path(pending.filename), new Date(0), new Date(0));
  await collectUnusedImages(root, db);
  expect(await fs.readFile(path(pending.filename), "utf8")).toBe(source);
});

it("collects an abandoned temporary-only file while retaining its decision", async () => {
  const pending = await interrupted();
  const temporary = path(`.upload-${pending.filename}`);
  await fs.rename(path(pending.filename), temporary);
  await fs.utimes(temporary, new Date(0), new Date(0));
  await collectUnusedImages(root, db);
  expect(existsSync(temporary)).toBe(true);
  await abandon(pending.filename, true);
  const decision = await rows();
  expect(existsSync(temporary)).toBe(true);
  await collectUnusedImages(root, db);
  expect(existsSync(temporary)).toBe(false);
  expect(await rows()).toEqual(decision);
});

it.each([false, true])(
  "cleanup releases only abandoned bytes without a live reference (linked=%s)",
  async (linked) => {
    const pending = await interrupted();
    await fs.link(path(pending.filename), path(`.upload-${pending.filename}`));
    if (linked) await reference(pending.filename);
    await fs.utimes(path(pending.filename), new Date(0), new Date(0));
    await fs.mkdir(path(".pending-delete"));
    await fs.writeFile(join(path(".pending-delete"), pending.filename), "");
    await collectUnusedImages(root, db);
    await retryImageDeletions(root, db);
    expect(existsSync(path(pending.filename))).toBe(true);
    expect(existsSync(path(`.upload-${pending.filename}`))).toBe(true);
    await abandon(pending.filename, true);
    const evidence = await rows();
    // Abandonment itself leaves every file intact.
    expect(existsSync(path(pending.filename))).toBe(true);
    await collectUnusedImages(root, db);
    await retryImageDeletions(root, db);
    expect(existsSync(path(pending.filename))).toBe(linked);
    expect(existsSync(path(`.upload-${pending.filename}`))).toBe(linked);
    if (linked) {
      await db.delete(cardTable);
      await collectUnusedImages(root, db);
      await retryImageDeletions(root, db);
      expect(existsSync(path(pending.filename))).toBe(false);
      expect(existsSync(path(`.upload-${pending.filename}`))).toBe(false);
    }
    expect(await rows()).toEqual(evidence);
  },
);

it.each(["", "   ", "\0", "x".repeat(1001)])(
  "refuses invalid abandonment reasons %#",
  async (reason) => {
    const pending = await interrupted();
    await expect(abandon(pending.filename, true, reason)).rejects.toThrow("Abandonment reason");
    expect(await rows()).toEqual([pending]);
  },
);

it("rejects invalid names and records before reading paths outside the workspace", async () => {
  const pending = await interrupted();
  const read = vi.spyOn(fs, "realpath");
  expect(await inspectImageUpload(root, { ...pending, filename: "../outside.svg" })).toEqual({
    published: "invalid-record",
    temporary: "invalid-record",
  });
  expect(read).not.toHaveBeenCalled();
  await expect(recover("../outside.svg", true)).rejects.toThrow("full image upload filename");
  await expect(recover("00000000-0000-4000-8000-000000000000.svg")).rejects.toThrow("not found");
});

it("lists unfinished records and bounds startup diagnostics without changing evidence", async () => {
  for (let index = 0; index < 7; index++) await store();
  const before = await rows();
  expect(await listImageUploads(db)).toHaveLength(7);
  const pending = await pendingImageUploads(db, root);
  expect(pending.total).toBe(7);
  expect(pending.named).toHaveLength(5);
  expect(pending.named.every((row) => row.evidence.published === "matching-content")).toBe(true);
  const warn = vi.fn();
  const startup = createLocalClaimStartupCheck(warn);
  await startup(db, root);
  await startup(db, root);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toContain("7 unfinished image upload(s)");
  expect(warn.mock.calls[0][0]).toContain("kozane image recover <filename>");
  expect(await rows()).toEqual(before);
  await abandon(before[0].filename, true);
  expect(await listImageUploads(db)).toHaveLength(6);
  expect(await listImageUploads(db, true)).toHaveLength(7);
});

it("refuses abandonment on another connection while installation owns the writer lock", async () => {
  const connection = await openDb(`file:${join(root, "db.sqlite")}`);
  await connection.db.values(sql`PRAGMA busy_timeout=1`);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const link = fs.link;
  let filename!: string;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    filename = String(to).split(/[/\\]/).pop()!;
    entered();
    await gate;
    return link(from, to);
  });
  const installation = store();
  try {
    await started;
    expect(
      (await abandonImageUpload(connection.db, filename, "Reviewed", false)).upload.state,
    ).toBe("pending");
    await connection.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(abandonImageUpload(connection.db, filename, "Reviewed", true)).rejects.toThrow();
    release();
    await installation;
    expect((await rows())[0].state).toBe("installed");
    await abandonImageUpload(connection.db, filename, "Reviewed", true);
    expect((await rows())[0].state).toBe("abandoned");
  } finally {
    release();
    await installation.catch(() => undefined);
    connection.close();
  }
});
