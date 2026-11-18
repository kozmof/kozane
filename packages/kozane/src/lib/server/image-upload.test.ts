import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { cardTable, localImageUploadTable } from "../../db/schema.js";
import { createNamespace } from "../../db/api/namespace.js";
import { getDefaultPartition } from "../../db/api/partition.js";
import { create, update } from "../../services/cards.js";
import { createServiceContext } from "../../services/context.js";
import {
  storeImage,
  imageDirectory,
  collectUnusedImages,
  retryImageDeletions,
} from "./image-assets.js";
import * as records from "../../db/api/image-upload.js";
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let namespaceId: string;
let partitionId: string;
const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';
const bytes = new TextEncoder().encode(source);
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kozane-upload-pins-"));
  db = await createTestDB(join(root, "db.sqlite"));
  namespaceId = await createNamespace({ db, name: "Main" });
  partitionId = (await getDefaultPartition({ db, namespaceId }))!.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const store = () => storeImage(root, db, "drawing.svg", bytes);
const uploads = () => db.select().from(localImageUploadTable);
const createCard = (url: string) =>
  create(db, createServiceContext(), namespaceId, { partitionId, content: "kozane-image:" + url });
async function queueDeletion(filename: string) {
  const queue = join(imageDirectory(root), ".pending-delete");
  await fs.mkdir(queue, { recursive: true });
  await fs.writeFile(join(queue, filename), "");
  await fs.utimes(join(imageDirectory(root), filename), new Date(0), new Date(0));
}

it("commits its immutable pin before publication and verifies installed bytes before returning", async () => {
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      const row = reader.prepare("SELECT * FROM local_image_upload").get();
      expect(row).toMatchObject({
        state: "pending",
        byte_length: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(existsSync(String(to))).toBe(false);
      expect(await fs.readFile(from, "utf8")).toBe(source);
    } finally {
      reader.close();
    }
    return link(from, to);
  });
  const url = await store();
  expect((await uploads())[0]).toMatchObject({
    filename: url.split("/").pop(),
    state: "installed",
    error: null,
    installedAt: expect.any(Date),
    completedAt: null,
  });
  expect(await fs.readFile(join(imageDirectory(root), url.split("/").pop()!), "utf8")).toBe(source);
  expect(
    (await fs.readdir(imageDirectory(root))).filter((name) => name.startsWith(".upload-")),
  ).toEqual([]);
});

it("creates no files or directories when the reservation cannot commit", async () => {
  await db.run(
    sql`CREATE TRIGGER reject_pin BEFORE INSERT ON local_image_upload BEGIN SELECT RAISE(ABORT,'reservation refused'); END`,
  );
  await expect(store()).rejects.toThrow();
  expect(await uploads()).toEqual([]);
  expect(existsSync(imageDirectory(root))).toBe(false);
});

it("retains an interrupted temporary file and error without repeating publication", async () => {
  const link = vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("Interrupted publication"));
  await expect(store()).rejects.toThrow("needs review");
  const [pending] = await uploads();
  expect(pending).toMatchObject({
    state: "pending",
    error: expect.stringContaining("Interrupted publication"),
  });
  expect(await fs.readFile(join(imageDirectory(root), `.upload-${pending.filename}`), "utf8")).toBe(
    source,
  );
  await collectUnusedImages(root, db);
  await retryImageDeletions(root, db);
  expect(link).toHaveBeenCalledOnce();
  expect(await uploads()).toEqual([pending]);
});

it.each(["collision", "corrupt"] as const)(
  "refuses %s bytes without overwriting or confirming them",
  async (mode) => {
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
      if (mode === "collision") await fs.writeFile(to, "Existing immutable bytes");
      await link(from, to);
      if (mode === "corrupt") await fs.writeFile(to, "Corrupt bytes");
    });
    await expect(store()).rejects.toThrow("needs review");
    const [row] = await uploads();
    expect(row.state).toBe("pending");
    expect(row.error).not.toBeNull();
    expect(await fs.readFile(join(imageDirectory(root), row.filename), "utf8")).toBe(
      mode === "collision" ? "Existing immutable bytes" : "Corrupt bytes",
    );
  },
);

it.each([false, true])(
  "retains installed bytes and pending intent when installation confirmation fails (commit=%s)",
  async (commit) => {
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_install AFTER UPDATE ON local_image_upload WHEN NEW.state='installed' BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_install BEFORE UPDATE ON local_image_upload WHEN NEW.state='installed' BEGIN SELECT RAISE(ABORT,'installation refused'); END`,
      );
    const link = vi.spyOn(fs, "link");
    await expect(store()).rejects.toThrow("needs review");
    const [pending] = await uploads();
    expect(pending).toMatchObject({ state: "pending", error: null, installedAt: null });
    await queueDeletion(pending.filename);
    await collectUnusedImages(root, db);
    await retryImageDeletions(root, db);
    expect(await fs.readFile(join(imageDirectory(root), pending.filename), "utf8")).toBe(source);
    expect(existsSync(join(imageDirectory(root), ".pending-delete", pending.filename))).toBe(true);
    expect(await uploads()).toEqual([pending]);
    expect(link).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "rolls back card references and pin completion together (commit=%s)",
  async (commit) => {
    const url = await store();
    const installed = await uploads();
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_complete AFTER UPDATE ON local_image_upload WHEN NEW.state='completed' BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_complete BEFORE UPDATE ON local_image_upload WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'completion refused'); END`,
      );
    await expect(createCard(url)).rejects.toThrow();
    expect(await db.select().from(cardTable)).toEqual([]);
    expect(await uploads()).toEqual(installed);
    await queueDeletion(installed[0].filename);
    await collectUnusedImages(root, db);
    await retryImageDeletions(root, db);
    expect(await fs.readFile(join(imageDirectory(root), installed[0].filename), "utf8")).toBe(
      source,
    );
    await db.run(sql`DROP TRIGGER reject_complete`);
    await createCard(url);
    expect((await uploads())[0]).toMatchObject({
      state: "completed",
      completedAt: expect.any(Date),
    });
  },
);

it("completes a staged upload when an existing card receives its reference", async () => {
  const card = await createCard("/api/images/00000000-0000-4000-8000-000000000000.svg");
  const url = await store();
  await update(db, createServiceContext(), namespaceId, card.id, {
    content: "kozane-image:" + url,
  });
  expect((await uploads())[0].state).toBe("completed");
});

it("preserves even old unreferenced uploads until their pin is resolved", async () => {
  const url = await store();
  const [installed] = await uploads();
  await queueDeletion(installed.filename);
  await collectUnusedImages(root, db, Date.now() + 864000000);
  await retryImageDeletions(root, db);
  expect((await uploads())[0].state).toBe("installed");
  expect(await fs.readFile(join(imageDirectory(root), url.split("/").pop()!), "utf8")).toBe(source);
});

it("refuses cleanup on another connection while installation owns the writer lock", async () => {
  const connection = await openDb(`file:${join(root, "db.sqlite")}`);
  await connection.db.values(sql`PRAGMA busy_timeout=1`);
  const link = fs.link;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    entered();
    await gate;
    return link(from, to);
  });
  const installed = store();
  try {
    await started;
    await expect(collectUnusedImages(root, connection.db)).rejects.toThrow();
    release();
    const url = await installed;
    await collectUnusedImages(root, connection.db);
    expect(await fs.readFile(join(imageDirectory(root), url.split("/").pop()!), "utf8")).toBe(
      source,
    );
    expect((await uploads())[0].state).toBe("installed");
  } finally {
    release();
    await installed.catch(() => undefined);
    connection.close();
  }
});

it("rejects symlinked image directories while retaining the reservation", async () => {
  const outside = await fs.mkdtemp(join(tmpdir(), "kozane-upload-outside-"));
  try {
    await fs.mkdir(join(root, ".kozane", "assets"), { recursive: true });
    await fs.symlink(outside, imageDirectory(root));
    await expect(store()).rejects.toThrow("needs review");
    expect((await uploads())[0]).toMatchObject({
      state: "pending",
      error: expect.stringContaining("unsafe"),
    });
    expect(await fs.readdir(outside)).toEqual([]);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it("keeps the pin when cleanup conflicts with a card transaction that later rolls back", async () => {
  const url = await store();
  const [installed] = await uploads();
  await queueDeletion(installed.filename);
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
  const complete = records.completeImageUploadsInTx;
  vi.spyOn(records, "completeImageUploadsInTx").mockImplementationOnce(async (tx) => {
    await complete(tx);
    entered();
    await gate;
    throw new Error("Card transaction failed");
  });
  const card = createCard(url);
  const failed = expect(card).rejects.toThrow("Card transaction failed");
  try {
    await started;
    await expect(retryImageDeletions(root, connection.db)).rejects.toThrow();
    release();
    await failed;
    await retryImageDeletions(root, connection.db);
    expect(await db.select().from(cardTable)).toEqual([]);
    expect(await uploads()).toEqual([installed]);
    expect(await fs.readFile(join(imageDirectory(root), installed.filename), "utf8")).toBe(source);
  } finally {
    release();
    await card.catch(() => undefined);
    connection.close();
  }
});
