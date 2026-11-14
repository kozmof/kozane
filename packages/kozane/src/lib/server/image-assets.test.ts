import { randomUUID } from "node:crypto";
import { deleteNamespaceInTx } from "../../db/api/namespace.js";
import { createNamespace } from "../../db/api/namespace.js";
import { getDefaultPartition } from "../../db/api/partition.js";
import { create, removeOne, removeInTx } from "../../services/cards.js";
import { createServiceContext } from "../../services/context.js";
import { describe, expect, it, vi } from "vitest";
import {
  withImageDeletion,
  retryImageDeletions,
  validateImage,
  storeImage,
  imageDirectory,
  collectUnusedImages,
  readImage,
  maintainImageAssets,
} from "./image-assets.js";
import { mkdtemp, readFile, rm, utimes, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDB } from "../../test-utils/db.js";
const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40"/></svg>',
);
describe("image assets", () => {
  it("checks signatures, extensions, limits, and active SVG content", async () => {
    expect(await validateImage("drawing.SVG", svg)).toBe("svg");
    for (const name of ["x.png", "x.jpg", "x.gif"])
      await expect(validateImage(name, svg)).rejects.toThrow();
    for (const text of [
      "",
      "<svg><rect></svg>",
      "<svg width=40/>",
      "<svg/><svg/>",
      "<html/>",
      "<svg><script/></svg>",
      '<svg onload="alert(1)"/>',
      '<svg><image href="https://example.com/a"/></svg>',
    ])
      await expect(validateImage("x.svg", new TextEncoder().encode(text))).rejects.toThrow();
    await expect(validateImage("x.png", new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow();
  });
  it("stores bytes and collects abandoned uploads only after the grace period", async () => {
    const root = await mkdtemp(join(tmpdir(), "kozane-images-"));
    const db = await createTestDB();
    try {
      const url = await storeImage(root, "drawing.svg", svg);
      const file = join(imageDirectory(root), url.split("/").pop()!);
      expect(Array.from(await readFile(file))).toEqual(Array.from(svg));
      await collectUnusedImages(root, db);
      expect(await readdir(imageDirectory(root))).toHaveLength(1);
      await utimes(file, new Date(0), new Date(0));
      const namespaceId = await createNamespace({ db, name: "Images" });
      const partition = await getDefaultPartition({ db, namespaceId });
      const card = await create(db, createServiceContext(), namespaceId, {
        partitionId: partition!.id,
        content: "kozane-image:" + url,
      });
      await collectUnusedImages(root, db);
      expect(await readdir(imageDirectory(root))).toHaveLength(1);
      await removeOne(db, createServiceContext(), namespaceId, card.id);
      await collectUnusedImages(root, db);
      expect(await readdir(imageDirectory(root))).toEqual([".retained"]);
      // A reference created after the collector's snapshot still resolves the bytes.
      expect(Array.from(await readImage(root, url.split("/").pop()!))).toEqual(Array.from(svg));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("accepts local SVG gradients, clips, and use references", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"/><clipPath id="clip"/><path id="shape"/></defs><use href="#shape" fill="url(#paint)" clip-path="url(\'#clip\')"/></svg>';
  expect(await validateImage("drawing.svg", new TextEncoder().encode(source))).toBe("svg");
  await expect(
    validateImage(
      "drawing.svg",
      new TextEncoder().encode('<svg><rect fill="url(https://example.com/a)"/></svg>'),
    ),
  ).rejects.toThrow();
});
it("never collects persistent assets from a memory session", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-memory-assets-"));
  const db = await createTestDB();
  try {
    const url = await storeImage(root, "drawing.svg", svg);
    const file = join(imageDirectory(root), url.split("/").pop()!);
    await utimes(file, new Date(0), new Date(0));
    vi.stubEnv("KOZANE_MEMORY_MODE", "1");
    await collectUnusedImages(root, db);
    expect(await readdir(imageDirectory(root))).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
it("contains cleanup failures and throttles repeated maintenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-maintenance-"));
  const db = await createTestDB();
  const select = vi.spyOn(db, "select").mockImplementation(() => {
    throw new Error("database unavailable");
  });
  try {
    await expect(maintainImageAssets(root, db, 1000)).resolves.toBeUndefined();
    await maintainImageAssets(root, db, 2000);
    expect(select).toHaveBeenCalledTimes(1);
    await maintainImageAssets(root, db, 3601001);
    expect(select).toHaveBeenCalledTimes(2);
  } finally {
    select.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("checks decoded SVG resource references", async () => {
  for (const source of [
    '<svg><rect fill="u&#114;l(https://example.com/a)"/></svg>',
    '<svg><rect fill="url(&#104;ttps://example.com/a)"/></svg>',
  ])
    await expect(validateImage("x.svg", new TextEncoder().encode(source))).rejects.toThrow();
  expect(
    await validateImage("x.svg", new TextEncoder().encode('<svg><use href="&#35;shape"/></svg>')),
  ).toBe("svg");
});
it("rejects malformed entities and duplicate SVG attributes", async () => {
  for (const source of [
    '<svg title="&"/>',
    '<svg title="&bogus;"/>',
    '<svg title="&#;"/>',
    '<svg width="1" width="2"/>',
  ]) {
    await expect(validateImage("x.svg", new TextEncoder().encode(source))).rejects.toThrow();
  }
  expect(await validateImage("x.svg", new TextEncoder().encode('<svg title="A &amp; B"/>'))).toBe(
    "svg",
  );
});

it("does not treat text inside quoted SVG values as attribute names", async () => {
  for (const source of [
    '<svg title=" width=example" width="100"/>',
    "<svg title=' width=example' width='100'/>",
    '<svg width="100" title=" width=example"/>',
  ])
    expect(await validateImage("drawing.svg", new TextEncoder().encode(source))).toBe("svg");
  await expect(
    validateImage(
      "drawing.svg",
      new TextEncoder().encode('<svg title=" width=example" width="100" width="200"/>'),
    ),
  ).rejects.toThrow();
});

it("deletes an image only when its last card is deleted, including archived images", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-delete-image-"));
  const db = await createTestDB();
  try {
    const namespaceId = await createNamespace({ db, name: "Deletion" });
    const partition = await getDefaultPartition({ db, namespaceId });
    const context = createServiceContext();
    const url = await storeImage(root, "image.svg", svg);
    const input = { partitionId: partition!.id, content: "kozane-image:" + url };
    const first = await create(db, context, namespaceId, input);
    const second = await create(db, context, namespaceId, input);
    await expect(
      withImageDeletion(root, db, async () => {
        throw new Error("Deletion failed");
      }),
    ).rejects.toThrow("Deletion failed");
    expect(Array.from(await readImage(root, url.split("/").pop()!))).toEqual(Array.from(svg));
    await withImageDeletion(root, db, async (tx, capture) => {
      await capture({ namespaceId, cardIds: [first.id] });
      return removeInTx(tx, context, namespaceId, { cardIds: [first.id] });
    });
    expect(Array.from(await readImage(root, url.split("/").pop()!))).toEqual(Array.from(svg));
    await withImageDeletion(root, db, async (tx, capture) => {
      await capture({ namespaceId, cardIds: [second.id] });
      return removeInTx(tx, context, namespaceId, { cardIds: [second.id] });
    });
    await expect(readImage(root, url.split("/").pop()!)).rejects.toThrow();
    const archivedUrl = await storeImage(root, "archived.svg", svg);
    await utimes(
      join(imageDirectory(root), archivedUrl.split("/").pop()!),
      new Date(0),
      new Date(0),
    );
    await collectUnusedImages(root, db);
    const archivedCard = await create(db, context, namespaceId, {
      ...input,
      content: "kozane-image:" + archivedUrl,
    });
    await withImageDeletion(root, db, async (tx, capture) => {
      await capture({ namespaceId, cardIds: [archivedCard.id] });
      return removeInTx(tx, context, namespaceId, { cardIds: [archivedCard.id] });
    });
    await expect(readImage(root, archivedUrl.split("/").pop()!)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cleans cascading namespace deletions and retries filesystem failures durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-image-retry-"));
  const db = await createTestDB();
  const context = createServiceContext();
  try {
    const namespaceId = await createNamespace({ db, name: "Cascade" });
    const partition = await getDefaultPartition({ db, namespaceId });
    const url = await storeImage(root, "image.svg", svg);
    await create(db, context, namespaceId, {
      partitionId: partition!.id,
      content: "kozane-image:" + url,
    });
    const name = url.split("/").pop()!;
    const filename = join(imageDirectory(root), name);
    await rm(filename);
    await mkdir(filename);
    await withImageDeletion(root, db, async (tx, capture) => {
      await capture({ namespaceId });
      return deleteNamespaceInTx({ db: tx, namespaceId });
    });
    expect(await readdir(join(imageDirectory(root), ".pending-delete"))).toContain(name);
    await rm(filename, { recursive: true });
    await retryImageDeletions(root, db);
    expect(await readdir(join(imageDirectory(root), ".pending-delete"))).toEqual([]);
    await expect(readImage(root, name)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("retries queues larger than one query batch while preserving shared references", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-batched-retries-"));
  const db = await createTestDB();
  try {
    const namespaceId = await createNamespace({ db, name: "Batch" });
    const partition = await getDefaultPartition({ db, namespaceId });
    const url = await storeImage(root, "shared.svg", svg);
    await create(db, createServiceContext(), namespaceId, {
      partitionId: partition!.id,
      content: "kozane-image:" + url,
    });
    const queue = join(imageDirectory(root), ".pending-delete");
    await mkdir(queue, { recursive: true });
    const shared = url.split("/").pop()!;
    const names = [shared, ...Array.from({ length: 400 }, () => randomUUID() + ".svg")];
    await Promise.all(names.map((name) => writeFile(join(queue, name), "")));
    await retryImageDeletions(root, db);
    expect(await readdir(queue)).toEqual([shared]);
    expect(Array.from(await readImage(root, shared))).toEqual(Array.from(svg));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
