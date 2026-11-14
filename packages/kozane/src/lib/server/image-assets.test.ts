import { createNamespace } from "../../db/api/namespace.js";
import { getDefaultPartition } from "../../db/api/partition.js";
import { create, removeOne } from "../../services/cards.js";
import { createServiceContext } from "../../services/context.js";
import { describe, expect, it, vi } from "vitest";
import {
  validateImage,
  storeImage,
  imageDirectory,
  collectUnusedImages,
  maintainImageAssets,
} from "./image-assets.js";
import { mkdtemp, readFile, rm, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDB } from "../../test-utils/db.js";
const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40"/></svg>',
);
describe("image assets", () => {
  it("checks signatures, extensions, limits, and active SVG content", () => {
    expect(validateImage("drawing.SVG", svg)).toBe("svg");
    for (const name of ["x.png", "x.jpg", "x.gif"])
      expect(() => validateImage(name, svg)).toThrow();
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
      expect(() => validateImage("x.svg", new TextEncoder().encode(text))).toThrow();
    expect(() => validateImage("x.png", new Uint8Array(10 * 1024 * 1024 + 1))).toThrow();
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
      expect(await readdir(imageDirectory(root))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("accepts local SVG gradients, clips, and use references", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"/><clipPath id="clip"/><path id="shape"/></defs><use href="#shape" fill="url(#paint)" clip-path="url(\'#clip\')"/></svg>';
  expect(validateImage("drawing.svg", new TextEncoder().encode(source))).toBe("svg");
  expect(() =>
    validateImage(
      "drawing.svg",
      new TextEncoder().encode('<svg><rect fill="url(https://example.com/a)"/></svg>'),
    ),
  ).toThrow();
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
