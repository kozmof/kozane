import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  installCapturePrototype,
  captureApplicationRows,
} from "../../test-utils/action-capture.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import {
  cardTable,
  layerTable,
  namespaceTable,
  partitionTable,
} from "../../../../core/src/schema.js";
import {
  ASSET_MANIFEST_VERSION,
  AssetManifestError,
  baselineAssetNames,
  effectAssetNames,
  buildAssetManifest,
  mergeAssetManifests,
  parseAssetManifest,
  verifyAssetManifest,
} from "../../../../core/src/actions/asset-manifest.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { IMAGE_MAX_BYTES } from "../../../../core/src/images.js";
import type { ProjectionEffect, ProjectionRow } from "../../../../core/src/actions/projection.js";

beforeEach(async () => {
  // jsdom omits SubtleCrypto. Real browsers and the WASM Node runner provide it.
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.png`;
const name = (n: number) => `.kozane/assets/images/${id(n)}`;
const ref = (n: number) => `kozane-image:/api/images/${id(n)}`;
const row = (n: number): ProjectionRow => ({
  table: "card",
  row: { id: ["text", "card"], content: ["text", ref(n)] },
});
const bytes = new TextEncoder().encode("abc");
const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const entry = (n = 1) => ({ name: name(n), byteLength: 3, sha256: hash });
const manifest = (...n: number[]) => ({ version: ASSET_MANIFEST_VERSION, entries: n.map(entry) });

it("collects sorted distinct baseline references from exact TEXT cells without interpreting blobs or embedded URLs", () => {
  const baseline: ProjectionRow[] = [
    row(2),
    row(1),
    row(2),
    {
      table: "other",
      row: {
        blob: ["blob", "616263"],
        count: ["integer", "9007199254740993"],
        empty: ["null"],
        prose: ["text", `An embedded ${ref(3)}`],
        remote: ["text", "https://remote/image.png"],
      },
    },
  ];
  expect(baselineAssetNames(baseline)).toEqual([name(1), name(2)]);
  expect(baseline[0]).toEqual(row(2));
});

it("retains original and nested invocation references plus every before and after image", () => {
  const names = effectAssetNames(
    [{ input: { content: ref(3), children: [{ input: { content: ref(4) } }] } }],
    [
      { before: row(1).row, after: row(2).row },
      { before: row(2).row, after: null },
    ],
  );
  expect(names).toEqual([name(1), name(2), name(3), name(4)]);
});

it("refuses malformed row values and unsafe invocation objects without running hooks", () => {
  expect(() =>
    baselineAssetNames([{ table: "card", row: { content: ["integer", "01"] } }]),
  ).toThrow();
  const getter = vi.fn(() => ref(1));
  const input = Object.defineProperty({}, "content", { enumerable: true, get: getter });
  expect(() => effectAssetNames([input], [])).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => effectAssetNames([cycle], [])).toThrow();
});

it("builds canonical manifests using actual SHA-256 bytes, deduplicates reads and owns its output", async () => {
  const read = vi.fn(async () => bytes);
  const built = await buildAssetManifest([name(2), name(1), name(1)], read);
  expect(built).toEqual(manifest(1, 2));
  expect(read.mock.calls).toHaveLength(2);
  expect(Object.isFrozen(built)).toBe(true);
  expect(Object.isFrozen(built.entries)).toBe(true);
  expect(Object.isFrozen(built.entries[0])).toBe(true);
  const input = manifest(2, 1);
  const parsed = parseAssetManifest(input);
  input.entries[0].sha256 = "0".repeat(64);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(manifest(1, 2)));
});

it("returns a complete empty manifest without reading assets", async () => {
  const read = vi.fn(async () => bytes);
  expect(await buildAssetManifest([], read)).toEqual(manifest());
  expect(await verifyAssetManifest(manifest(), [], read)).toEqual(manifest());
  expect(read).not.toHaveBeenCalled();
});

it("owns read buffers before awaiting hashing", async () => {
  const loaded = new Uint8Array(bytes);
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (algorithm, input) => {
    loaded.fill(0);
    return digest(algorithm, input);
  });
  expect(await buildAssetManifest([name(1)], async () => loaded)).toEqual(manifest(1));
  expect(loaded).toEqual(new Uint8Array(3));
});

it.each([
  "../outside.png",
  "/api/images/file.png",
  ".kozane/assets/images/../escape.png",
  name(1) + "?query",
  name(1).replace(".png", ".exe"),
])("refuses unsafe or unsupported asset names before reading: %s", async (invalid) => {
  const read = vi.fn(async () => bytes);
  await expect(buildAssetManifest([name(1), invalid], read)).rejects.toBeInstanceOf(
    AssetManifestError,
  );
  expect(read).not.toHaveBeenCalled();
});

it.each([0, IMAGE_MAX_BYTES + 1])("refuses asset bytes of unsupported length %s", async (size) => {
  await expect(buildAssetManifest([name(1)], async () => new Uint8Array(size))).rejects.toThrow(
    "length",
  );
});

it("fails a build if a required asset is missing without returning a partial manifest", async () => {
  const read = vi.fn(async (asset: string) => {
    if (asset === name(2)) throw new Error("missing asset");
    return bytes;
  });
  await expect(buildAssetManifest([name(1), name(2)], read)).rejects.toThrow("missing asset");
  expect(read.mock.calls.map(([asset]) => asset)).toEqual([name(1), name(2)]);
});

it.each([
  { version: 2, entries: [] },
  { version: 1, entries: [], extra: true },
  { version: 1, entries: [entry(), entry()] },
  { version: 1, entries: [{ ...entry(), byteLength: 0 }] },
  { version: 1, entries: [{ ...entry(), byteLength: 1.5 }] },
  { version: 1, entries: [{ ...entry(), sha256: hash.toUpperCase() }] },
  { version: 1, entries: [{ ...entry(), sha256: hash + "\n" }] },
  { version: 1, entries: [{ ...entry(), extra: true }] },
  { version: 1, entries: [{ ...entry(), name: "../image.png" }] },
  { version: 1, entries: new Array(1) },
])("refuses malformed manifest transport %#", (input) => {
  expect(() => parseAssetManifest(input)).toThrow(AssetManifestError);
});

it("refuses accessors, symbols and serialization hooks without invoking them", () => {
  const hook = vi.fn(() => 1);
  const input = Object.defineProperty({ entries: [] }, "version", { enumerable: true, get: hook });
  expect(() => parseAssetManifest(input)).toThrow();
  expect(() => parseAssetManifest({ ...manifest(1), [Symbol("hidden")]: true })).toThrow();
  expect(() => parseAssetManifest({ ...manifest(1), toJSON: hook })).toThrow();
  expect(hook).not.toHaveBeenCalled();
});

it("verifies required coverage before reads and checks both byte length and hash", async () => {
  const read = vi.fn(async () => bytes);
  await expect(verifyAssetManifest(manifest(1), [name(1), name(2)], read)).rejects.toThrow(
    "cover exactly",
  );
  await expect(verifyAssetManifest(manifest(1, 2), [name(1)], read)).rejects.toThrow(
    "cover exactly",
  );
  expect(read).not.toHaveBeenCalled();
  expect(await verifyAssetManifest(manifest(1), [name(1)], read)).toEqual(manifest(1));
  await expect(
    verifyAssetManifest(manifest(1), [name(1)], async () => new TextEncoder().encode("abd")),
  ).rejects.toThrow("do not match");
  await expect(
    verifyAssetManifest(manifest(1), [name(1)], async () => new TextEncoder().encode("abcd")),
  ).rejects.toThrow("do not match");
});

it("captures requirements and manifest fields before awaiting host reads", async () => {
  const required = [name(1)];
  const input = manifest(1);
  let release!: (value: Uint8Array) => void;
  const started = verifyAssetManifest(
    input,
    required,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  input.entries[0].sha256 = "0".repeat(64);
  required.push(name(2));
  release(bytes);
  expect(await started).toEqual(manifest(1));
});

it("merges history requirements and refuses name collisions with different hashes or lengths", () => {
  expect(mergeAssetManifests([manifest(2), manifest(1, 2)])).toEqual(manifest(1, 2));
  for (const changed of [
    { ...entry(), sha256: "0".repeat(64) },
    { ...entry(), byteLength: 4 },
  ])
    expect(() => mergeAssetManifests([manifest(1), { version: 1, entries: [changed] }])).toThrow(
      "Conflicting",
    );
});

it("builds and verifies manifests from real captured history including a deleted intermediate image", async () => {
  // Both adapter configurations resolve this packaged fixture to the same core source handle.
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(namespaceTable).values({ id: "n", name: "Main", isDefault: true });
  await db.insert(layerTable).values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db
    .insert(partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await db.insert(cardTable).values({ id: "c", layerId: "l", partitionId: "p", content: ref(1) });
  const staged = await buildAssetManifest([name(1), name(2), name(3)], async () => bytes);
  const capture = await installCapturePrototype(db, staged);
  const registry = defineActionRegistry<{ replace: unknown }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [24],
    definitions: {
      replace: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, { context }) => {
          await context.db
            .update(cardTable)
            .set({ content: ref(2) })
            .where(eq(cardTable.id, "c"));
          await context.db.delete(cardTable).where(eq(cardTable.id, "c"));
        },
      },
    },
  });
  const group = await runActionGroup({
    db,
    registry,
    schemaVersion: 24,
    invocation: { id: "root", kind: "replace", contractVersion: 1, input: { content: ref(3) } },
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => {
        throw new Error("Unexpected ID");
      },
      now: () => {
        throw new Error("Unexpected clock");
      },
    }),
    createContext: (_actions, db) => ({ db }),
    ...capture.hooks("run"),
  });
  const effects: ProjectionEffect[] = await capture.effects("run");
  expect(baselineAssetNames(await captureApplicationRows(db))).toEqual([]);
  const baselineNames = baselineAssetNames(capture.baseline);
  const historyNames = effectAssetNames([group.invocation, ...group.executions], effects);
  expect(baselineNames).toEqual([name(1)]);
  expect(historyNames).toEqual([name(1), name(2), name(3)]);
  const storage = new Map(historyNames.map((asset) => [asset, bytes]));
  const read = async (asset: string) => {
    const value = storage.get(asset);
    if (!value) throw new Error("Missing retained image");
    return value;
  };
  const before = await captureApplicationRows(db);
  const baseline = await buildAssetManifest(baselineNames, read);
  const history = await buildAssetManifest(historyNames, read);
  expect(mergeAssetManifests([baseline, history]).entries.map((entry) => entry.name)).toEqual(
    historyNames,
  );
  storage.delete(name(2));
  await expect(verifyAssetManifest(history, historyNames, read)).rejects.toThrow(
    "Missing retained image",
  );
  expect(await captureApplicationRows(db)).toEqual(before);
  storage.set(name(2), bytes);
  expect(await verifyAssetManifest(history, historyNames, read)).toEqual(history);
  await capture.restore(async () => (await createTestDB()) as unknown as DB, [], read);
  expect(baselineAssetNames(await captureApplicationRows(db))).toEqual(baselineNames);
});
