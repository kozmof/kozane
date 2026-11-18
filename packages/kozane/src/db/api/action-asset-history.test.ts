import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  captureApplicationRows,
  installCapturePrototype,
  openCapturePrototype,
} from "../../test-utils/action-capture.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import {
  cardTable,
  layerTable,
  namespaceTable,
  partitionTable,
  taskspaceLocalTable,
} from "../../../../core/src/schema.js";
import {
  buildAssetManifest,
  parseAssetManifest,
  selectAssetManifest,
} from "../../../../core/src/actions/asset-manifest.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";

beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const name = (n: number) =>
  `.kozane/assets/images/00000000-0000-4000-8000-${String(n).padStart(12, "0")}.png`;
const ref = (n: number) => "kozane-image:/api/images/" + name(n).split("/").pop();
const bytes = (text: string) => new TextEncoder().encode(text);
const database = async () => (await createTestDB()) as unknown as DB;
const emptyMarker = [
  { mode: "record", runId: null, actionId: null, executionOrd: null, nextEffectOrd: 0 },
];
type Input = { next: string | null; extra?: string; noop?: boolean };
async function fixture() {
  const db = await database();
  await db.insert(namespaceTable).values({ id: "n", name: "Main", isDefault: true });
  await db.insert(layerTable).values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db
    .insert(partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await db.insert(cardTable).values({ id: "c", layerId: "l", partitionId: "p", content: ref(1) });
  await db.insert(taskspaceLocalTable).values({ taskspaceId: "absent", path: "local/retained" });
  const storage = new Map([1, 2, 3, 4].map((n) => [name(n), bytes(`Image ${n}`)]));
  const read = vi.fn(async (name: string) => {
    const value = storage.get(name);
    if (!value) throw new Error("Missing retained image");
    return value;
  });
  const catalog = await buildAssetManifest([...storage.keys()], read);
  read.mockClear();
  const capture = await installCapturePrototype(db, catalog);
  const registry = defineActionRegistry<{ replace: Input }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [24],
    definitions: {
      replace: {
        eligibility: "syncable",
        prepare: (input) => input as Input,
        replay: async (input, { context }) => {
          if (input.noop) return;
          if (input.next === null) await context.db.delete(cardTable).where(eq(cardTable.id, "c"));
          else
            await context.db
              .update(cardTable)
              .set({ content: input.next })
              .where(eq(cardTable.id, "c"));
        },
      },
    },
  });
  const run = (id: string, input: Input, assets = catalog) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 24,
      invocation: { id, kind: "replace", contractVersion: 1, input },
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
      ...capture.hooks(id, assets),
    });
  const state = async () => ({
    rows: await captureApplicationRows(db),
    local: await db.select().from(taskspaceLocalTable),
    runs: await capture.runs(),
    selection: await capture.selection(),
    marker: await capture.marker(),
  });
  return { db, capture, storage, read, catalog, run, state };
}

it("selects only required catalog entries and refuses missing names without changing the catalog", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.catalog);
  expect(
    selectAssetManifest(f.catalog, [name(2), name(1), name(1)]).entries.map((entry) => entry.name),
  ).toEqual([name(1), name(2)]);
  expect(() => selectAssetManifest(f.catalog, [name(5)])).toThrow("missing from staged catalog");
  expect(JSON.stringify(f.catalog)).toBe(before);
});

it("stores manifests with baseline rows and finalized actions, then reopens them from SQL", async () => {
  const f = await fixture();
  expect(f.capture.baselineManifest.entries.map((entry) => entry.name)).toEqual([name(1)]);
  const [baseline] = await f.db.values(sql`SELECT rows,asset_manifest FROM capture_baseline`);
  expect(JSON.parse(String(baseline[0]))).toEqual(f.capture.baseline);
  expect(parseAssetManifest(JSON.parse(String(baseline[1])))).toEqual(f.capture.baselineManifest);
  await f.run("replace", { next: ref(2), extra: ref(3) });
  expect(f.read).not.toHaveBeenCalled();
  const [run] = await f.capture.runs();
  expect(run.complete).toBe(1);
  expect(parseAssetManifest(JSON.parse(run.assets!)).entries.map((entry) => entry.name)).toEqual([
    name(1),
    name(2),
    name(3),
  ]);
  const reopened = await openCapturePrototype(f.db);
  expect(reopened.baseline).toEqual(f.capture.baseline);
  expect(reopened.baselineManifest).toEqual(f.capture.baselineManifest);
  await reopened.verify();
  await reopened.restore(database, [], f.read);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await reopened.runs()).toEqual([run]);
  expect(await reopened.marker()).toEqual(emptyMarker);
});

it("refuses baseline installation without required metadata and leaves rows and triggers unchanged", async () => {
  const db = await database();
  await db.insert(namespaceTable).values({ id: "n", name: ref(1), isDefault: true });
  const before = await captureApplicationRows(db);
  const objects = await db.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
  await expect(installCapturePrototype(db)).rejects.toThrow("missing from staged catalog");
  expect(await captureApplicationRows(db)).toEqual(before);
  expect(await db.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`)).toEqual(objects);
});

it("rolls back baseline rows and manifests if installation fails after creating their tables", async () => {
  const db = await database();
  await db.run(sql`CREATE TABLE capture_effect(existing TEXT)`);
  const before = await db.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
  await expect(installCapturePrototype(db)).rejects.toThrow();
  expect(await db.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`)).toEqual(before);
});

it("requires staged metadata for invocation-only references even when an action makes no row changes", async () => {
  const f = await fixture();
  const before = await f.state();
  const insufficient = selectAssetManifest(f.catalog, [name(1)]);
  await expect(f.run("noop", { next: ref(3), noop: true }, insufficient)).rejects.toThrow(
    "missing from staged catalog",
  );
  expect(await f.state()).toEqual(before);
  await f.run("noop", { next: ref(3), noop: true });
  expect(await f.capture.effects("noop")).toEqual([]);
  expect(
    parseAssetManifest(JSON.parse((await f.capture.runs())[0].assets!)).entries.map(
      (entry) => entry.name,
    ),
  ).toEqual([name(3)]);
});

it.each([false, true])(
  "rolls back manifests with application changes and captured effects after completion failure (commit=%s)",
  async (commit) => {
    const f = await fixture();
    if (commit) {
      await f.db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.db.run(
        sql`CREATE TRIGGER reject_manifest AFTER UPDATE ON capture_run WHEN NEW.complete=1 BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_manifest BEFORE UPDATE ON capture_run WHEN NEW.complete=1 BEGIN SELECT RAISE(ABORT,'manifest refused'); END`,
      );
    const before = await f.state();
    await expect(f.run("failed", { next: ref(2) })).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    expect(await f.capture.effects("failed")).toEqual([]);
    await f.db.run(sql`DROP TRIGGER reject_manifest`);
    await f.run("success", { next: ref(2) });
    expect((await f.capture.runs())[0].assets).not.toBeNull();
  },
);

it("refuses different bytes under a retained name even when the conflicting run is no longer selected", async () => {
  const f = await fixture();
  await f.run("original", { next: ref(2) });
  await f.capture.restore(database, [], f.read);
  const before = await f.state();
  f.storage.set(name(2), bytes("Different immutable bytes"));
  const changed = await buildAssetManifest([...f.storage.keys()], f.read);
  await expect(f.run("conflict", { next: ref(2) }, changed)).rejects.toThrow(
    "Conflicting asset bytes",
  );
  expect(await f.state()).toEqual(before);
  expect(await f.capture.effects("conflict")).toEqual([]);
});

it.each(["missing", "corrupt", "missing-manifest", "extra-manifest"] as const)(
  "refuses %s history assets before creating a validation database or changing destination rows",
  async (failure) => {
    const f = await fixture();
    await f.run("replace", { next: ref(2), extra: ref(3) });
    if (failure === "missing") f.storage.delete(name(3));
    if (failure === "corrupt") f.storage.set(name(2), bytes("Invalid"));
    if (failure === "missing-manifest")
      await f.db.run(sql`UPDATE capture_run SET asset_manifest='{"version":1,"entries":[]}'`);
    if (failure === "extra-manifest")
      await f.db.run(sql`UPDATE capture_run SET asset_manifest=${JSON.stringify(f.catalog)}`);
    const before = await f.state();
    const validate = vi.fn(database);
    await expect(f.capture.restore(validate, ["replace"], f.read)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(before);
  },
);

it("restores the baseline without requiring assets from unselected history", async () => {
  const f = await fixture();
  await f.run("replace", { next: ref(2), extra: ref(3) });
  f.storage.delete(name(2));
  f.storage.delete(name(3));
  f.read.mockClear();
  await f.capture.restore(database, [], f.read);
  expect(f.read.mock.calls.map(([name]) => name)).toEqual([name(1)]);
  expect((await f.db.select().from(cardTable))[0].content).toBe(ref(1));
  expect(await f.capture.selection()).toEqual([]);
  expect(await f.capture.runs()).toHaveLength(1);
});

it("requires an asset reader for nonempty restoration and never silently skips byte verification", async () => {
  const f = await fixture();
  await f.run("replace", { next: ref(2) });
  const before = await f.state();
  await expect(f.capture.restore(database, [])).rejects.toThrow("Asset reader is required");
  expect(await f.state()).toEqual(before);
});

it("reads and transfers assets outside the write transaction and refuses history changed during staging", async () => {
  const f = await fixture();
  await f.run("replace", { next: ref(2) });
  let changed = false;
  const read = async (asset: string) => {
    if (!changed) {
      changed = true;
      // This action can commit because no restoration transaction holds the writer lock.
      await f.run("concurrent", { next: ref(4) });
    }
    return f.read(asset);
  };
  const validate = vi.fn(database);
  await expect(f.capture.restore(validate, [], read)).rejects.toThrow(
    "history changed while staging",
  );
  expect(validate).not.toHaveBeenCalled();
  expect((await f.db.select().from(cardTable))[0].content).toBe(ref(4));
  expect(await f.capture.selection()).toEqual(["replace", "concurrent"]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.capture.verify();
});

it("refuses changed baseline encoding after reopening instead of trusting a cached baseline", async () => {
  const f = await fixture();
  const reopened = await openCapturePrototype(f.db);
  await f.db.run(sql`UPDATE capture_baseline SET row_encoding_ver=2`);
  const before = await f.state();
  await expect(reopened.restore(database, [], f.read)).rejects.toThrow(
    "unsupported baseline row encoding",
  );
  await expect(openCapturePrototype(f.db)).rejects.toThrow("unsupported baseline row encoding");
  expect(await f.state()).toEqual(before);
});

it("owns staged catalog metadata before an action begins", async () => {
  const f = await fixture();
  const catalog: { version: 1; entries: { name: string; byteLength: number; sha256: string }[] } =
    JSON.parse(JSON.stringify(f.catalog));
  const hooks = f.capture.hooks("copy", catalog);
  catalog.entries[0].name = name(5);
  const registry = defineActionRegistry<{ noop: unknown }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [24],
    definitions: {
      noop: { eligibility: "syncable", prepare: (input) => input, replay: async () => undefined },
    },
  });
  await runActionGroup({
    db: f.db,
    registry,
    schemaVersion: 24,
    invocation: { id: "copy", kind: "noop", contractVersion: 1, input: { content: ref(1) } },
    bindings: createActionBindings({ mode: "record", allocateId: () => "unused", now: () => 0 }),
    createContext: (_actions, db) => ({ db }),
    ...hooks,
  });
  expect(
    parseAssetManifest(JSON.parse((await f.capture.runs())[0].assets!)).entries.map(
      (entry) => entry.name,
    ),
  ).toEqual([name(1)]);
});
