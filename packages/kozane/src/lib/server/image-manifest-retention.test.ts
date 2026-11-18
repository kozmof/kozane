import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { withTx } from "../../db/database.js";
import { localAssetManifestTable, localImageUploadTable, namespaceTable } from "../../db/schema.js";
import { createNamespace } from "../../db/api/namespace.js";
import { getDefaultPartition } from "../../db/api/partition.js";
import {
  reserveAssetManifest,
  releaseAssetManifest,
  inspectAssetManifest,
  type AssetManifestOwner,
} from "../../db/api/asset-manifest.js";
import { create, removeInTx } from "../../services/cards.js";
import { createServiceContext } from "../../services/context.js";
import {
  storeImage,
  imageDirectory,
  collectUnusedImages,
  retryImageDeletions,
  withImageDeletion,
  readImage,
} from "./image-assets.js";
import { abandonImageUpload } from "./image-upload-recovery.js";
import { retainImageManifest, retainImageManifestInTx } from "./image-manifest-retention.js";
import * as evidence from "./image-upload-evidence.js";
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let namespaceId: string;
let partitionId: string;
const source = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const bytes = new TextEncoder().encode(source);
const owner: AssetManifestOwner = { kind: "effect-set", id: "retained-history" };
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "kozane-manifest-retention-"));
  db = await createTestDB(join(root, "db.sqlite"));
  namespaceId = await createNamespace({ db, name: "Main" });
  partitionId = (await getDefaultPartition({ db, namespaceId }))!.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function uploaded(card = true) {
  const url = await storeImage(root, db, "drawing.svg", bytes);
  const [upload] = await db.select().from(localImageUploadTable);
  const manifest = {
    version: 1,
    entries: [
      {
        name: `.kozane/assets/images/${upload.filename}`,
        byteLength: upload.byteLength,
        sha256: upload.sha256,
      },
    ],
  };
  const created = card
    ? await create(db, createServiceContext(), namespaceId, {
        partitionId,
        content: "kozane-image:" + url,
      })
    : null;
  return {
    url,
    upload,
    manifest,
    card: created,
    file: join(imageDirectory(root), upload.filename),
  };
}
async function removeCard(id: string) {
  await withImageDeletion(root, db, async (tx, capture) => {
    await capture({ namespaceId, cardIds: [id] });
    return removeInTx(tx, createServiceContext(), namespaceId, { cardIds: [id] });
  });
}
async function queue(filename: string) {
  const directory = join(imageDirectory(root), ".pending-delete");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, filename), "");
}

it.each([false, true])(
  "protects an image after its last card is deleted (verified=%s)",
  async (verify) => {
    const f = await uploaded();
    await reserveAssetManifest(db, owner, f.manifest);
    if (verify) await retainImageManifest(db, root, owner);
    await removeCard(f.card!.id);
    await fs.utimes(f.file, new Date(0), new Date(0));
    await collectUnusedImages(root, db);
    await retryImageDeletions(root, db);
    expect(await fs.readFile(f.file, "utf8")).toBe(source);
    expect(existsSync(join(imageDirectory(root), ".pending-delete", f.upload.filename))).toBe(true);
    const original = (await inspectAssetManifest(db, owner)).record;
    await releaseAssetManifest(db, owner, "History pruned");
    expect(existsSync(f.file)).toBe(true);
    await retryImageDeletions(root, db);
    expect(existsSync(f.file)).toBe(false);
    expect((await inspectAssetManifest(db, owner)).record).toMatchObject({
      ...original,
      state: "released",
      releasedAt: expect.any(Date),
      releaseReason: "History pruned",
    });
  },
);

it("keeps independent manifest and live-reference protection after another owner releases", async () => {
  const f = await uploaded();
  const other = { kind: "recovery" as const, id: "checkpoint" };
  await reserveAssetManifest(db, owner, f.manifest);
  await reserveAssetManifest(db, other, f.manifest);
  await removeCard(f.card!.id);
  await releaseAssetManifest(db, owner, "History pruned");
  await retryImageDeletions(root, db);
  expect(existsSync(f.file)).toBe(true);
  const linked = await create(db, createServiceContext(), namespaceId, {
    partitionId,
    content: "kozane-image:" + f.url,
  });
  await releaseAssetManifest(db, other, "Checkpoint expired");
  await retryImageDeletions(root, db);
  expect(existsSync(f.file)).toBe(true);
  await removeCard(linked.id);
  expect(existsSync(f.file)).toBe(false);
});

it("keeps manifest-protected temporary and published bytes after upload abandonment", async () => {
  const f = await uploaded(false);
  const temporary = join(imageDirectory(root), `.upload-${f.upload.filename}`);
  await fs.link(f.file, temporary);
  await reserveAssetManifest(db, { kind: "transfer", id: "incoming" }, f.manifest);
  await abandonImageUpload(db, f.upload.filename, "Upload replaced by transfer", true);
  await fs.utimes(f.file, new Date(0), new Date(0));
  await queue(f.upload.filename);
  await collectUnusedImages(root, db);
  await retryImageDeletions(root, db);
  expect(existsSync(f.file)).toBe(true);
  expect(existsSync(temporary)).toBe(true);
  await releaseAssetManifest(db, { kind: "transfer", id: "incoming" }, "Transfer abandoned");
  await retryImageDeletions(root, db);
  expect(existsSync(f.file)).toBe(false);
  expect(existsSync(temporary)).toBe(false);
});

it("verifies readable archived bytes without copying them back to the live directory", async () => {
  const f = await uploaded();
  // No deletion wrapper, so ordinary collection archives this unreferenced legacy image.
  await withTx(db, (tx) => tx.run(sql`DELETE FROM card`));
  await fs.utimes(f.file, new Date(0), new Date(0));
  await collectUnusedImages(root, db);
  expect(existsSync(f.file)).toBe(false);
  await reserveAssetManifest(db, owner, f.manifest);
  const retained = await retainImageManifest(db, root, owner);
  expect(retained.record.state).toBe("retained");
  expect((await retainImageManifest(db, root, owner)).changed).toBe(false);
  expect(existsSync(f.file)).toBe(false);
  await queue(f.upload.filename);
  await retryImageDeletions(root, db);
  expect(Array.from(await readImage(root, f.upload.filename))).toEqual(Array.from(bytes));
});

it.each(["missing", "changed", "symlink", "archive-symlink"] as const)(
  "retains the pending reservation when bytes are %s",
  async (failure) => {
    const f = await uploaded(false);
    const pending = await reserveAssetManifest(db, owner, f.manifest);
    if (failure === "missing") await fs.rm(f.file);
    if (failure === "changed") await fs.writeFile(f.file, "Different bytes");
    if (failure === "symlink") {
      await fs.rename(f.file, join(root, "kept"));
      await fs.symlink(join(root, "kept"), f.file);
    }
    if (failure === "archive-symlink") {
      await fs.mkdir(join(root, "kept"));
      await fs.rename(f.file, join(root, "kept", f.upload.filename));
      await fs.symlink(join(root, "kept"), join(imageDirectory(root), ".retained"));
    }
    await expect(retainImageManifest(db, root, owner)).rejects.toThrow("Required image");
    expect((await inspectAssetManifest(db, owner)).record).toEqual(pending.record);
  },
);

it("refuses corrupt live bytes even when an archived copy matches", async () => {
  const f = await uploaded(false);
  await fs.mkdir(join(imageDirectory(root), ".retained"));
  await fs.copyFile(f.file, join(imageDirectory(root), ".retained", f.upload.filename));
  await fs.writeFile(f.file, "Different bytes");
  const pending = await reserveAssetManifest(db, owner, f.manifest);
  await expect(retainImageManifest(db, root, owner)).rejects.toThrow("different-content");
  expect((await inspectAssetManifest(db, owner)).record).toEqual(pending.record);
});

it("keeps verification and dependent publication atomic without changing files", async () => {
  const f = await uploaded(false);
  const pending = await reserveAssetManifest(db, owner, f.manifest);
  await expect(
    withTx(db, async (tx) => {
      await tx.update(namespaceTable).set({ name: "Uncommitted owner" });
      await retainImageManifestInTx(tx, root, owner);
      throw new Error("Owner publication failed");
    }),
  ).rejects.toThrow("Owner publication failed");
  expect((await db.select().from(namespaceTable))[0].name).toBe("Main");
  expect((await inspectAssetManifest(db, owner)).record).toEqual(pending.record);
  expect(await fs.readFile(f.file, "utf8")).toBe(source);
  await withTx(db, async (tx) => {
    await tx.update(namespaceTable).set({ name: "Published" });
    await retainImageManifestInTx(tx, root, owner);
  });
  expect((await inspectAssetManifest(db, owner)).record.state).toBe("retained");
});

it("fails cleanup closed if an active manifest is malformed", async () => {
  const f = await uploaded();
  await queue(f.upload.filename);
  await fs.utimes(f.file, new Date(0), new Date(0));
  await db.insert(localAssetManifestTable).values({
    ownerKind: "baseline",
    ownerId: "corrupt",
    state: "pending",
    manifest: "{}",
    createdAt: new Date(),
  });
  await expect(collectUnusedImages(root, db)).rejects.toThrow();
  await expect(retryImageDeletions(root, db)).rejects.toThrow();
  expect(await fs.readFile(f.file, "utf8")).toBe(source);
});

it("refuses upload-name collisions with released manifest identity before touching disk", async () => {
  const filename = "00000000-0000-4000-8000-000000000001.svg";
  await reserveAssetManifest(db, owner, {
    version: 1,
    entries: [{ name: `.kozane/assets/images/${filename}`, byteLength: 3, sha256: "a".repeat(64) }],
  });
  await releaseAssetManifest(db, owner, "Expired");
  vi.mocked(crypto.randomUUID).mockReturnValueOnce("00000000-0000-4000-8000-000000000001");
  await expect(storeImage(root, db, "drawing.svg", bytes)).rejects.toThrow(
    "Conflicting asset bytes",
  );
  expect(await db.select().from(localImageUploadTable)).toEqual([]);
  expect(existsSync(imageDirectory(root))).toBe(false);
});

it("does not release an owner on another connection while verification holds the writer lock", async () => {
  const f = await uploaded(false);
  await reserveAssetManifest(db, owner, f.manifest);
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
  const inspect = evidence.inspectRetainedImage;
  vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return inspect(...args);
  });
  const verifying = retainImageManifest(db, root, owner);
  try {
    await started;
    await expect(
      releaseAssetManifest(connection.db, owner, "Conflicting release"),
    ).rejects.toThrow();
    release();
    await verifying;
    expect((await inspectAssetManifest(db, owner)).record.state).toBe("retained");
    expect(await fs.readFile(f.file, "utf8")).toBe(source);
  } finally {
    release();
    await verifying.catch(() => undefined);
    connection.close();
  }
});
