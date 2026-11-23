import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { mergeAssetManifests } from "@kozane/core";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import {
  retainedRecoveryAssetFixture,
  identity,
  clone,
  manifest,
} from "../../test-utils/retained-recovery-assets.js";
import * as localLoader from "./local-recovery-payload.js";
import * as sharedLoader from "./shared-recovery-payload.js";
import * as executionLoader from "./shared-recovery-execution-payload.js";
import * as actionLoader from "./shared-recovery-action-payload.js";
import * as retainedLoader from "./shared-recovery-retained-payload.js";
import * as assetLoader from "./recovery-asset-payload.js";
import {
  saveRegisteredRetainedRecoveryAssetPayload,
  loadRegisteredRetainedRecoveryAssetPayload,
  inspectRegisteredRetainedRecoveryAssetPayload,
} from "./retained-recovery-asset-payload.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let source: Awaited<ReturnType<typeof retainedRecoveryAssetFixture>>;
let assets: Awaited<ReturnType<typeof recovery.describeRetainedRecoveryAssets>>;
const key = {
  workspaceId: identity.workspaceId,
  deviceId: identity.deviceId,
  epochId: identity.epochId,
  checkpointId: identity.checkpointId,
};
const factory = () => createTestDB();
const directory = () => join(root, ".kozane", "recovery", "retained-asset-manifests");
const published = () => join(directory(), `${assets.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${assets.checkpoint.sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(assets.payload));
const sourceNames = ["local", "shared", "executions", "originals", "retained", "current"] as const;
type Source = (typeof sourceNames)[number];
const tables = {
  assets: "local_recovery_retained_assets",
  retained: "local_recovery_retained_history",
  current: "local_recovery_assets",
  originals: "local_recovery_actions",
  executions: "local_recovery_executions",
  shared: "local_recovery_shared_history",
  local: "local_recovery_checkpoint",
} as const;
function checkpoints() {
  const retained = assets.checkpoint.binding.checkpoint,
    originals = retained.checkpoint,
    executions = originals.checkpoint;
  return {
    assets: assets.checkpoint,
    retained,
    originals,
    executions,
    shared: executions.checkpoint,
    local: assets.checkpoint.binding.localCheckpoint,
    current: assets.checkpoint.assetCheckpoint,
  };
}
const sourceDescriptor = (name: Source) => checkpoints()[name];
const sourceArea = (name: Source) =>
  name === "local"
    ? "checkpoints"
    : name === "shared"
      ? "shared-history"
      : name === "originals"
        ? "actions"
        : name === "retained"
          ? "retained-history"
          : name === "current"
            ? "asset-manifests"
            : "executions";
const sourceDirectory = (name: Source) => join(root, ".kozane", "recovery", sourceArea(name));
const sourcePath = (name: Source) =>
  join(sourceDirectory(name), `${sourceDescriptor(name).sha256}.json`);
const sourceTemporary = (name: Source) =>
  join(sourceDirectory(name), `.pending-${sourceDescriptor(name).sha256}.json`);
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: sourceDescriptor("local").byteLength,
  sharedMaxBytes: sourceDescriptor("shared").byteLength,
  executionMaxBytes: sourceDescriptor("executions").byteLength,
  actionMaxBytes: sourceDescriptor("originals").byteLength,
  retainedMaxBytes: sourceDescriptor("retained").byteLength,
  assetMaxBytes: sourceDescriptor("current").byteLength,
  maxBytes: assets.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const save = () =>
  saveRegisteredRetainedRecoveryAssetPayload({ ...options(), input: assets.payload });
const load = () => loadRegisteredRetainedRecoveryAssetPayload(options());
const inspect = () => inspectRegisteredRetainedRecoveryAssetPayload(root, db, key);
const catalog = async () =>
  Promise.all(
    Object.values(tables).map((table) =>
      db.values(sql.raw(`SELECT descriptor,CAST(created_at AS TEXT) FROM ${table}`)),
    ),
  );
async function saveSources() {
  const ctx = options();
  await localLoader.saveRegisteredLocalRecoveryPayload({ ...ctx, input: source.localSnapshot });
  await sharedLoader.saveRegisteredSharedRecoveryPayload({ ...ctx, input: source.sharedHistory });
  await executionLoader.saveRegisteredSharedRecoveryExecutionPayload({
    ...ctx,
    input: source.executions,
  });
  await actionLoader.saveRegisteredSharedRecoveryActionPayload({
    ...ctx,
    input: source.originalActions,
  });
  await retainedLoader.saveRegisteredSharedRecoveryRetainedPayload({
    ...ctx,
    input: source.retainedHistory,
  });
  await assetLoader.saveRegisteredRecoveryAssetPayload({
    root,
    db,
    expected: identity,
    localMaxBytes: ctx.localMaxBytes,
    sharedMaxBytes: ctx.sharedMaxBytes,
    createValidationDatabase: factory,
    input: source.currentAssets,
  });
}
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-retained-assets-payload-"));
  db = await createTestDB(join(root, "db.sqlite"));
  source = await retainedRecoveryAssetFixture();
  assets = await recovery.describeRetainedRecoveryAssets(source);
  const cp = checkpoints();
  await recovery.rememberLocalRecoveryCheckpoint(db, cp.local);
  await recovery.rememberSharedRecoveryCheckpoint(db, cp.shared);
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, cp.executions);
  await recovery.rememberSharedRecoveryActionCheckpoint(db, cp.originals);
  await recovery.rememberSharedRecoveryRetainedCheckpoint(db, cp.retained);
  await recovery.rememberRecoveryAssetCheckpoint(db, cp.current);
  await recovery.rememberRetainedRecoveryAssetCheckpoint(db, cp.assets);
  await saveSources();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});
it("publishes canonical per-run manifests after all seven expectations commit and preserves every source", async () => {
  const before = await catalog(),
    sourceBytes = await Promise.all(sourceNames.map((name) => fs.readFile(sourcePath(name)))),
    link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      for (const [name, cp] of Object.entries(checkpoints()))
        expect(
          reader.prepare(`SELECT descriptor FROM ${tables[name as keyof typeof tables]}`).get()
            ?.descriptor,
        ).toBe(JSON.stringify(cp));
    } finally {
      reader.close();
    }
    expect(await fs.readFile(String(from))).toEqual(bytes());
    expect(existsSync(String(to))).toBe(false);
    return link(from, to);
  });
  expect(await save()).toEqual({ path: published(), checkpoint: assets.checkpoint, changed: true });
  expect(await fs.readFile(published())).toEqual(bytes());
  expect(existsSync(temporary())).toBe(false);
  if (process.platform !== "win32") expect((await fs.stat(published())).mode & 0o777).toBe(0o600);
  const stat = await fs.stat(published(), { bigint: true });
  expect((await save()).changed).toBe(false);
  expect(await fs.stat(published(), { bigint: true })).toMatchObject({
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
  });
  expect(await Promise.all(sourceNames.map((name) => fs.readFile(sourcePath(name))))).toEqual(
    sourceBytes,
  );
  expect(await catalog()).toEqual(before);
  expect(existsSync(join(root, ".kozane", "assets"))).toBe(false);
});
it("reopens exact per-run, original and combined requirements without filesystem writes or live installation", async () => {
  await save();
  const before = await catalog(),
    reopened = await openDb(`file:${join(root, "db.sqlite")}`),
    targets: Awaited<ReturnType<typeof factory>>[] = [];
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredRetainedRecoveryAssetPayload({
      ...options(),
      db: reopened.db,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    });
    expect(result).toEqual({ payload: assets.payload, checkpoint: assets.checkpoint });
    expect(result.payload.manifest).toEqual(
      manifest(0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16),
    );
    expect(result.payload.history.effectSets.map(({ id }) => id)).toEqual([
      "origin",
      "noop",
      "superseded",
      "rebase",
    ]);
    expect(result.payload.originalImages).toEqual(source.originalImages);
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      Object.isFrozen(result.payload.history.effectSets[0].history.baseline.manifest.entries),
    ).toBe(true);
  } finally {
    reopened.close();
  }
  expect(targets).toHaveLength(23);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM local_image_upload`)).toEqual([]);
  }
  expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
  expect(await catalog()).toEqual(before);
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" && (call[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
});
it("inspects missing and orphaned evidence without creating paths or authorizing loading", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_retained_history`);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(save()).rejects.toThrow();
  await expect(load()).rejects.toThrow();
  expect(await fs.readFile(published())).toEqual(bytes());
});
it.each([
  "maxBytes",
  "localMaxBytes",
  "sharedMaxBytes",
  "executionMaxBytes",
  "actionMaxBytes",
  "retainedMaxBytes",
  "assetMaxBytes",
] as const)("enforces independent %s before file reads or SQL allocation", async (field) => {
  await save();
  const input = options();
  input[field]--;
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  await expect(
    loadRegisteredRetainedRecoveryAssetPayload({ ...input, createValidationDatabase: create }),
  ).rejects.toThrow("exceeds read limit");
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid byte limit %s before reads",
  async (limit) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    for (const field of [
      "maxBytes",
      "localMaxBytes",
      "sharedMaxBytes",
      "executionMaxBytes",
      "actionMaxBytes",
      "retainedMaxBytes",
      "assetMaxBytes",
    ])
      await expect(
        loadRegisteredRetainedRecoveryAssetPayload({
          ...options(),
          [field]: limit,
          createValidationDatabase: create,
        }),
      ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(Object.values(tables))("requires %s before opening any payloads", async (table) => {
  await db.run(sql.raw(`DELETE FROM ${table}`));
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  for (const mode of ["save", "load"])
    await expect(
      mode === "save"
        ? saveRegisteredRetainedRecoveryAssetPayload({
            ...options(),
            input: assets.payload,
            createValidationDatabase: create,
          })
        : loadRegisteredRetainedRecoveryAssetPayload({
            ...options(),
            createValidationDatabase: create,
          }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it("requires complete host identity before file reads", async () => {
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  for (const field of ["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)
    await expect(
      loadRegisteredRetainedRecoveryAssetPayload({
        ...options(),
        expected: { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it.each(sourceNames)(
  "requires saved %s bytes and preserves source temporary evidence",
  async (name) => {
    await fs.rename(sourcePath(name), sourceTemporary(name));
    const before = await fs.readFile(sourceTemporary(name));
    await expect(save()).rejects.toThrow();
    expect(existsSync(directory())).toBe(false);
    expect(await fs.readFile(sourceTemporary(name))).toEqual(before);
  },
);
it.each(["per-run", "original", "combined", "source-binding"])(
  "refuses altered %s metadata before source SQL allocation",
  async (change) => {
    const input = clone(assets.payload);
    if (change === "per-run")
      input.history.effectSets[0].history.effectSets[0].manifest.entries.pop();
    if (change === "original") input.originalImages.entries.pop();
    if (change === "combined") input.manifest.entries.push(manifest(17).entries[0]);
    if (change === "source-binding") input.assetCheckpoint.sha256 = "b".repeat(64);
    const create = vi.fn(factory);
    await expect(
      saveRegisteredRetainedRecoveryAssetPayload({
        ...options(),
        input,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("content mismatch");
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(directory())).toBe(false);
  },
);
function descriptor(payload: recovery.RetainedRecoveryAssetPayload) {
  const data = Buffer.from(JSON.stringify(payload));
  return {
    ...assets.checkpoint,
    binding: payload.binding,
    assetCheckpoint: payload.assetCheckpoint,
    byteLength: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
it.each(["baseline", "effect", "original", "combined", "extra"])(
  "checks %s coverage even when canonical manifest hashes match",
  async (gap) => {
    const payload = clone(assets.payload);
    if (gap === "baseline") payload.history.effectSets[0].history.baseline.manifest.entries = [];
    if (gap === "effect")
      payload.history.effectSets[2].history.effectSets[0].manifest.entries =
        payload.history.effectSets[2].history.effectSets[0].manifest.entries.filter(
          (entry: any) => entry.name !== manifest(8).entries[0].name,
        );
    if (gap === "original")
      payload.originalImages.entries = payload.originalImages.entries.filter(
        (entry: any) => entry.name !== manifest(11).entries[0].name,
      );
    if (gap === "combined")
      payload.manifest.entries = payload.manifest.entries.filter(
        (entry: any) => entry.name !== manifest(13).entries[0].name,
      );
    if (gap === "extra") payload.manifest.entries.push(manifest(17).entries[0]);
    assets = {
      payload: recovery.parseRetainedRecoveryAssetPayload(payload),
      checkpoint: descriptor(payload),
    };
    await db.run(
      sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(assets.checkpoint)}`,
    );
    for (const mode of ["save", "load"]) {
      if (mode === "load") {
        await fs.mkdir(directory(), { recursive: true });
        await fs.writeFile(published(), bytes());
      }
      await expect(mode === "save" ? save() : load()).rejects.toThrow();
      if (mode === "save") expect(existsSync(directory())).toBe(false);
      else expect(await fs.readFile(published())).toEqual(bytes());
    }
  },
);
it.each(["assets", "retained", "current", "originals", "executions", "shared", "local"] as const)(
  "rechecks %s changes after all source validation",
  async (name) => {
    await save();
    const verify = recovery.requireRetainedRecoveryAssetCheckpoint;
    vi.spyOn(recovery, "requireRetainedRecoveryAssetCheckpoint").mockImplementationOnce(
      async (...args) => {
        const result = await verify(...args);
        await db.run(
          sql`UPDATE ${sql.raw(tables[name])} SET descriptor=${JSON.stringify({ ...checkpoints()[name], sha256: "b".repeat(64) })}`,
        );
        return result;
      },
    );
    await expect(load()).rejects.toThrow("binding changed");
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it.each(sourceNames)(
  "rechecks %s source files after validation and during publication",
  async (name) => {
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
      await fs.writeFile(sourcePath(name), "changed");
      return link(...args);
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  },
);
it.each(["removed", "rewritten", "replaced", "temporary"])(
  "refuses %s manifest files after validation",
  async (change) => {
    await save();
    const verify = recovery.requireRetainedRecoveryAssetCheckpoint;
    vi.spyOn(recovery, "requireRetainedRecoveryAssetCheckpoint").mockImplementationOnce(
      async (...args) => {
        const result = await verify(...args);
        if (change === "removed") await fs.unlink(published());
        if (change === "rewritten") {
          await fs.writeFile(published(), bytes());
          await fs.utimes(published(), new Date(2000), new Date(2000));
        }
        if (change === "replaced") {
          const next = join(directory(), "next.json");
          await fs.writeFile(next, bytes());
          await fs.rename(next, published());
        }
        if (change === "temporary") await fs.writeFile(temporary(), bytes());
        return result;
      },
    );
    await expect(load()).rejects.toThrow();
  },
);
it.each(sourceNames)("refuses new %s temporary evidence after validation", async (name) => {
  await save();
  const verify = recovery.requireRetainedRecoveryAssetCheckpoint;
  vi.spyOn(recovery, "requireRetainedRecoveryAssetCheckpoint").mockImplementationOnce(
    async (...args) => {
      const result = await verify(...args);
      await fs.writeFile(sourceTemporary(name), "partial");
      return result;
    },
  );
  await expect(load()).rejects.toThrow("needs review");
  expect(await fs.readFile(sourceTemporary(name), "utf8")).toBe("partial");
});
it("refuses coherent replacement of all seven original catalog bindings", async () => {
  const verify = recovery.requireRetainedRecoveryAssetCheckpoint;
  vi.spyOn(recovery, "requireRetainedRecoveryAssetCheckpoint").mockImplementationOnce(
    async (...args) => {
      const result = await verify(...args),
        old = checkpoints(),
        local = { ...old.local, sha256: "b".repeat(64) },
        shared = { ...old.shared, sha256: "c".repeat(64) },
        executions = { ...old.executions, checkpoint: shared },
        originals = { ...old.originals, checkpoint: executions },
        retained = { ...old.retained, checkpoint: originals },
        current = { ...old.current, binding: { checkpoint: shared, localCheckpoint: local } },
        next = {
          ...old.assets,
          binding: { checkpoint: retained, localCheckpoint: local },
          assetCheckpoint: current,
        };
      await withTx(db, async (tx) => {
        await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(local)}`);
        for (const [table, cp] of [
          [tables.shared, shared],
          [tables.executions, executions],
          [tables.originals, originals],
          [tables.retained, retained],
        ] as const)
          await tx.run(
            sql`UPDATE ${sql.raw(table)} SET descriptor=${JSON.stringify(cp)},local_descriptor=${JSON.stringify(local)}`,
          );
        await tx.run(sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(current)}`);
        await tx.run(
          sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(next)}`,
        );
      });
      return result;
    },
  );
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});
it.each(["save", "load"])(
  "owns input, identity, root and all limits during %s callbacks",
  async (mode) => {
    if (mode === "load") await save();
    const input = { ...options(), input: clone(assets.payload), expected: { ...identity } };
    input.createValidationDatabase = async () => {
      input.input.history.effectSets.length = 0;
      input.input.originalImages.entries.length = 0;
      input.expected.deviceId = "changed";
      input.root = join(root, "elsewhere");
      input.localMaxBytes = 0;
      input.sharedMaxBytes = 0;
      input.executionMaxBytes = 0;
      input.actionMaxBytes = 0;
      input.retainedMaxBytes = 0;
      input.assetMaxBytes = 0;
      input.maxBytes = 0;
      return factory();
    };
    if (mode === "save") await saveRegisteredRetainedRecoveryAssetPayload(input);
    else
      expect((await loadRegisteredRetainedRecoveryAssetPayload(input)).payload).toEqual(
        assets.payload,
      );
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it.each(["save", "load"])(
  "preserves published evidence after the final %s commit fails",
  async (mode) => {
    if (mode === "load") await save();
    let ready = false;
    const verify = recovery.requireRetainedRecoveryAssetCheckpoint;
    vi.spyOn(recovery, "requireRetainedRecoveryAssetCheckpoint").mockImplementationOnce(
      async (...args) => {
        const result = await verify(...args);
        ready = true;
        return result;
      },
    );
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(db, async (tx) => {
          const result = await work(tx);
          if (ready) {
            await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
            await tx.run(
              sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
            );
            await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
          }
          return result;
        }),
    });
    const before = await catalog();
    await expect(
      mode === "save"
        ? saveRegisteredRetainedRecoveryAssetPayload({
            ...options(),
            input: assets.payload,
            db: wrapped,
          })
        : loadRegisteredRetainedRecoveryAssetPayload({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);
it("serializes all seven catalog removals across manifest publication", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>(),
    link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return link(...args);
  });
  const saving = save();
  try {
    await entered.promise;
    for (const table of Object.values(tables)) {
      await other.db.values(sql`PRAGMA busy_timeout=1`);
      await expect(
        withTx(other.db, (tx) => tx.run(sql.raw(`DELETE FROM ${table}`))),
      ).rejects.toThrow();
    }
    proceed.resolve();
    await saving;
  } finally {
    proceed.resolve();
    await saving.catch(() => undefined);
    other.close();
  }
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
});

it.each(["before-affinity", "after-foreign-key"])(
  "validates deselected %s SQL states despite matching saved source hashes",
  async (defect) => {
    const retained = clone(source.retainedHistory),
      set = retained.effectSets[2];
    const warp = {
      id: ["text", "w"],
      namespace_id: ["text", defect === "before-affinity" ? "n" : "missing"],
      pos_x: ["integer", "0"],
      pos_y: defect === "before-affinity" ? ["real", "3ff0000000000000"] : ["integer", "0"],
    };
    if (defect === "before-affinity")
      set.history.history.baseline.projection.tables
        .find((table: any) => table.name === "warp")
        .rows.push(warp);
    else {
      set.history.history.effectSets[0].effects.push({
        ord: 2,
        table: "warp",
        key: { id: ["text", "w"] },
        op: "I",
        before: null,
        after: warp,
      });
      set.history.selection.effectSets[0].effectCount++;
      set.executions.effectSets[0].effects.push({ ord: 2, actionId: "root", executionOrd: 0 });
    }
    const history = await recovery.describeSharedRecoveryHistory(
      set.history.history,
      identity,
      set.history.selection,
    );
    set.history = history.payload;
    set.executions = (
      await recovery.describeSharedRecoveryExecutions({
        checkpoint: history.checkpoint,
        sharedHistory: history.payload,
        selection: set.executions.selection,
        effectSets: set.executions.effectSets,
      })
    ).payload;
    retained.selection.effectSets[2].effectCount = set.history.selection.effectSets[0].effectCount;
    const prepared = await recovery.describeSharedRecoveryRetainedHistory({
      checkpoint: retained.checkpoint,
      selection: retained.selection,
      effectSets: retained.effectSets,
      originals: source.originalActions,
      executions: source.executions,
      sharedHistory: source.sharedHistory,
    });
    source.retainedHistory = prepared.payload;
    source.binding.checkpoint = prepared.checkpoint;
    assets = await recovery.describeRetainedRecoveryAssets(source);
    await db.run(
      sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify(prepared.checkpoint)}`,
    );
    await db.run(
      sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(assets.checkpoint)}`,
    );
    await fs.writeFile(sourcePath("retained"), JSON.stringify(prepared.payload));
    for (const mode of ["save", "load"]) {
      if (mode === "load") {
        await fs.mkdir(directory(), { recursive: true });
        await fs.writeFile(published(), bytes());
      }
      const targets: Awaited<ReturnType<typeof factory>>[] = [];
      const input = {
        ...options(),
        createValidationDatabase: async () => {
          const target = await factory();
          targets.push(target);
          return target;
        },
      };
      await expect(
        mode === "save"
          ? saveRegisteredRetainedRecoveryAssetPayload({ ...input, input: assets.payload })
          : loadRegisteredRetainedRecoveryAssetPayload(input),
      ).rejects.toThrow();
      expect(targets).toHaveLength(defect === "before-affinity" ? 11 : 12);
      for (const target of targets) {
        expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
        expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
        expect(await target.values(sql`SELECT 1 FROM local_image_upload`)).toEqual([]);
      }
      if (mode === "save") expect(existsSync(directory())).toBe(false);
      else expect(await fs.readFile(published())).toEqual(bytes());
    }
  },
);
it("reads a retained manifest larger than the fixed verification buffer", async () => {
  source.originalImages = mergeAssetManifests([
    source.originalImages,
    manifest(...Array.from({ length: 500 }, (_, n) => n + 100)),
  ]);
  assets = await recovery.describeRetainedRecoveryAssets(source);
  await db.run(
    sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(assets.checkpoint)}`,
  );
  expect(assets.checkpoint.byteLength).toBeGreaterThan(65536);
  expect((await save()).changed).toBe(true);
  expect((await load()).payload).toEqual(assets.payload);
  expect(await fs.readFile(published())).toEqual(bytes());
});

it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary retained evidence",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), temporary());
    } else
      await fs.writeFile(temporary(), state === "matching" ? bytes() : Buffer.from("{partial"));
    const link = vi.spyOn(fs, "link"),
      unlink = vi.spyOn(fs, "unlink");
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(await inspect()).toMatchObject({
      published: "absent",
      temporary:
        state === "matching"
          ? "matching-content"
          : state === "symlink"
            ? "unsafe-path"
            : "different-content",
    });
  },
);
it.each(["different", "directory", "symlink"])(
  "refuses an existing %s final path without replacement",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "directory") await fs.mkdir(published());
    if (state === "different") await fs.writeFile(published(), "different");
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), published());
    }
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(existsSync(temporary())).toBe(false);
    expect(await inspect()).toMatchObject({
      published: state === "symlink" ? "unsafe-path" : "different-content",
      temporary: "absent",
    });
  },
);
it("refuses a symlinked retained directory without writing its target", async () => {
  await fs.mkdir(join(root, "outside"));
  await fs.symlink(join(root, "outside"), directory());
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await fs.readdir(join(root, "outside"))).toEqual([]);
});
it.each(["link", "unlink"] as const)(
  "preserves file and catalog evidence after %s failure",
  async (failure) => {
    vi.spyOn(fs, failure).mockRejectedValueOnce(new Error("Publication failed"));
    const before = await catalog();
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: failure === "link" ? "absent" : "matching-content",
      temporary: "matching-content",
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await catalog()).toEqual(before);
  },
);
it.each(["partial-write", "file-sync", "directory-sync"])(
  "preserves retained evidence after %s failure",
  async (failure) => {
    if (failure === "directory-sync" && process.platform === "win32") return;
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
            await write(bytes().subarray(0, 10));
            throw new Error("Partial write");
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
it.each(["missing", "corrupt", "symlink", "temporary"])(
  "refuses %s retained bytes before source SQL allocation",
  async (state) => {
    await save();
    if (state === "missing") await fs.unlink(published());
    if (state === "corrupt") await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    if (state === "symlink") {
      await fs.rename(published(), join(root, "outside"));
      await fs.symlink(join(root, "outside"), published());
    }
    if (state === "temporary") await fs.writeFile(temporary(), bytes());
    const create = vi.fn(factory);
    await expect(
      loadRegisteredRetainedRecoveryAssetPayload({
        ...options(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["utf8", "json", "noncanonical", "bom"])(
  "refuses hash-matching invalid %s retained bytes before SQL allocation",
  async (state) => {
    const content =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(assets.payload))
            : Buffer.from(JSON.stringify(assets.payload, null, 2));
    const checkpoint = {
      ...assets.checkpoint,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
    await db.run(
      sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(checkpoint)}`,
    );
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredRetainedRecoveryAssetPayload({
        ...options(),
        maxBytes: content.length,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
