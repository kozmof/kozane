import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { createNamespace } from "../../db/api/namespace.js";
import { cardTable, layerTable, partitionTable } from "../../db/schema.js";
import {
  collectUnusedImages,
  imageDirectory,
  readImage,
  retryImageDeletions,
  withImageDeletion,
} from "./image-assets.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
let root: string;
let outside: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let namespaceId: string;
const name = "00000000-0000-4000-8000-000000000001.svg";
const source = "Original image bytes";
const images = () => imageDirectory(root);
const live = () => join(images(), name);
const archive = () => join(images(), ".retained");
const queue = () => join(images(), ".pending-delete");
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kozane-image-cleanup-"));
  outside = await fs.mkdtemp(join(tmpdir(), "kozane-outside-cleanup-"));
  db = await createTestDB(join(root, "db.sqlite"));
  namespaceId = await createNamespace({ db, name: "Cleanup" });
  await fs.mkdir(images(), { recursive: true });
  await fs.writeFile(live(), source);
  await fs.utimes(live(), new Date(0), new Date(0));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
async function reference() {
  const [layer] = await db.select().from(layerTable);
  const [partition] = await db.select().from(partitionTable);
  await db.insert(cardTable).values({
    id: "card",
    layerId: layer.id,
    partitionId: partition.id,
    content: "kozane-image:/api/images/" + name,
  });
}
function removeCard(failCommit = false) {
  return withImageDeletion(root, db, async (tx, capture) => {
    await capture({ namespaceId, cardIds: ["card"] });
    await tx.delete(cardTable).where(eq(cardTable.id, "card"));
    if (failCommit) await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
    return { ok: true };
  });
}
async function tree(dir = outside): Promise<[string, string][]> {
  const rows: [string, string][] = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    rows.push([
      relative(outside, path),
      entry.isDirectory() ? "directory" : (await fs.readFile(path)).toString("hex"),
    ]);
    if (entry.isDirectory()) rows.push(...(await tree(path)));
  }
  return rows;
}

it.each(["different", "same", "symlink", "directory"] as const)(
  "never overwrites an existing %s archive entry",
  async (kind) => {
    await fs.mkdir(archive());
    const retained = join(archive(), name);
    if (kind === "directory") await fs.mkdir(retained);
    else if (kind === "symlink") {
      await fs.writeFile(join(outside, name), "Outside bytes");
      await fs.symlink(join(outside, name), retained);
    } else await fs.writeFile(retained, kind === "same" ? source : "Earlier retained bytes");
    const original = await fs.lstat(retained, { bigint: true });
    await collectUnusedImages(root, db);
    expect(await fs.readFile(live(), "utf8")).toBe(source);
    expect((await fs.lstat(retained, { bigint: true })).ino).toBe(original.ino);
    if (kind === "directory") expect((await fs.lstat(retained)).isDirectory()).toBe(true);
    else
      expect(await fs.readFile(retained, "utf8")).toBe(
        kind === "same" ? source : kind === "symlink" ? "Outside bytes" : "Earlier retained bytes",
      );
  },
);

it.each(["symlink", "directory"] as const)(
  "leaves an unexpected live %s untouched",
  async (kind) => {
    await fs.rm(live());
    if (kind === "directory") await fs.mkdir(live());
    else {
      await fs.writeFile(join(outside, name), "Outside bytes");
      await fs.utimes(join(outside, name), new Date(0), new Date(0));
      await fs.symlink(join(outside, name), live());
    }
    await fs.utimes(live(), new Date(0), new Date(0));
    await collectUnusedImages(root, db);
    expect(existsSync(live())).toBe(true);
    expect(existsSync(join(archive(), name))).toBe(false);
  },
);

it("finishes an interrupted hard-link archive without replacing either file", async () => {
  await fs.mkdir(archive());
  const retained = join(archive(), name);
  await fs.link(live(), retained);
  const original = await fs.lstat(retained, { bigint: true });
  await collectUnusedImages(root, db);
  expect(existsSync(live())).toBe(false);
  expect((await fs.lstat(retained, { bigint: true })).ino).toBe(original.ino);
  expect(new TextDecoder().decode(await readImage(root, name))).toBe(source);
});

it.each([
  "link",
  "after-link",
  ...(process.platform === "win32" ? [] : ["archive-sync"]),
  "unlink",
])("preserves image bytes after interrupted archive %s", async (stage) => {
  const link = fs.link;
  const open = fs.open;
  let interrupted = false;
  if (stage === "link" || stage === "after-link")
    vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
      interrupted = true;
      if (stage === "after-link") await link(...args);
      throw new Error("Interrupted archive");
    });
  if (stage === "unlink")
    vi.spyOn(fs, "unlink").mockImplementationOnce(async () => {
      interrupted = true;
      throw new Error("Interrupted unlink");
    });
  if (stage === "archive-sync")
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === archive() && !interrupted) {
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          interrupted = true;
          throw new Error("Interrupted archive sync");
        });
      }
      return handle;
    });
  await collectUnusedImages(root, db);
  expect(interrupted).toBe(true);
  expect(await fs.readFile(live(), "utf8")).toBe(source);
  vi.restoreAllMocks();
  await collectUnusedImages(root, db);
  expect(existsSync(live())).toBe(false);
  expect(new TextDecoder().decode(await readImage(root, name))).toBe(source);
});

it.each(
  ["collect", "retry", "queue"].flatMap((operation) =>
    [".kozane", "assets", "images", ".retained", ".pending-delete"].map((component) => ({
      operation,
      component,
    })),
  ),
)(
  "refuses a symlinked $component during $operation and preserves outside bytes",
  async ({ operation, component }) => {
    const externalImages =
      component === ".kozane"
        ? join(outside, "assets", "images")
        : component === "assets"
          ? join(outside, "images")
          : outside;
    await fs.mkdir(join(externalImages, ".retained"), { recursive: true });
    await fs.mkdir(join(externalImages, ".pending-delete"), { recursive: true });
    await fs.writeFile(join(externalImages, name), "Outside bytes");
    await fs.utimes(join(externalImages, name), new Date(0), new Date(0));
    await fs.writeFile(join(externalImages, ".pending-delete", name), "");
    await fs.mkdir(queue(), { recursive: true });
    await fs.writeFile(join(queue(), name), "");
    const target =
      component === ".kozane"
        ? join(root, ".kozane")
        : component === "assets"
          ? join(root, ".kozane", "assets")
          : component === "images"
            ? images()
            : join(images(), component);
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(outside, target, "dir");
    if (operation === "queue") await reference();
    const before = await tree();
    await expect(
      operation === "collect"
        ? collectUnusedImages(root, db)
        : operation === "retry"
          ? retryImageDeletions(root, db)
          : removeCard(),
    ).rejects.toThrow("unsafe");
    expect(await tree()).toEqual(before);
    if (operation === "queue") expect(await db.select().from(cardTable)).toHaveLength(1);
  },
);

it.each(process.platform === "win32" ? ["file"] : ["file", "directory"])(
  "keeps the card and an orphaned request after deletion request %s sync fails",
  async (kind) => {
    await reference();
    const open = fs.open;
    let interrupted = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!interrupted && String(args[0]) === (kind === "file" ? join(queue(), name) : queue())) {
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          interrupted = true;
          throw new Error("Interrupted request sync");
        });
      }
      return handle;
    });
    await expect(removeCard()).rejects.toThrow("request sync");
    expect(interrupted).toBe(true);
    expect(await db.select().from(cardTable)).toHaveLength(1);
    expect(await fs.readFile(live(), "utf8")).toBe(source);
    expect(existsSync(join(queue(), name))).toBe(true);
    vi.restoreAllMocks();
    await retryImageDeletions(root, db);
    expect(existsSync(join(queue(), name))).toBe(true);
    await removeCard();
    expect(existsSync(live())).toBe(false);
    expect(existsSync(join(queue(), name))).toBe(false);
  },
);

it("retains a durable deletion request after the card commit fails", async () => {
  await reference();
  await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE deferred_child(id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  await expect(removeCard(true)).rejects.toThrow();
  expect(await db.select().from(cardTable)).toHaveLength(1);
  expect(existsSync(join(queue(), name))).toBe(true);
  await retryImageDeletions(root, db);
  expect(await fs.readFile(live(), "utf8")).toBe(source);
  expect(existsSync(join(queue(), name))).toBe(true);
  await removeCard();
  expect(existsSync(join(queue(), name))).toBe(false);
});

it.each(
  ["retry", "queue"].flatMap((operation) =>
    ["nonempty", "symlink", "directory"].map((kind) => ({ operation, kind })),
  ),
)(
  "preserves files behind an unsafe $kind deletion request during $operation",
  async ({ operation, kind }) => {
    await fs.mkdir(queue());
    const request = join(queue(), name);
    if (kind === "nonempty") await fs.writeFile(request, "Unreviewed request contents");
    if (kind === "directory") await fs.mkdir(request);
    if (kind === "symlink") {
      await fs.writeFile(join(outside, name), "Outside bytes");
      await fs.symlink(join(outside, name), request);
    }
    if (operation === "queue") {
      await reference();
      await expect(removeCard()).rejects.toThrow("unsafe");
      expect(await db.select().from(cardTable)).toHaveLength(1);
    } else await retryImageDeletions(root, db);
    expect(await fs.readFile(live(), "utf8")).toBe(source);
    expect(existsSync(request)).toBe(true);
    if (kind === "symlink")
      expect(await fs.readFile(join(outside, name), "utf8")).toBe("Outside bytes");
  },
);

it.each(["replace", "recreate"])(
  "preserves a replacement request and newer bytes after %s",
  async (method) => {
    await fs.mkdir(queue());
    const request = join(queue(), name);
    await fs.writeFile(request, "");
    const open = fs.open;
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === images() && !replaced) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          replaced = true;
          if (method === "replace") {
            await fs.writeFile(join(queue(), ".replacement"), "");
            await fs.rename(join(queue(), ".replacement"), request);
          } else {
            await fs.unlink(request);
            await fs.writeFile(request, "");
          }
          await fs.writeFile(live(), "Later bytes");
          await sync();
        });
      }
      return handle;
    });
    await retryImageDeletions(root, db);
    expect(replaced).toBe(true);
    expect(await fs.readFile(live(), "utf8")).toBe("Later bytes");
    expect(existsSync(request)).toBe(true);
  },
);
