import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  withTx,
  withReadTx,
  withMigration,
  createDatabaseAdapter,
  type DB,
  type DatabaseHandle,
} from "@kozane/core/database";
import { applyMigrations, migrations } from "@kozane/core/migrations";
import { localRecoveryRetainedAssetsTable, namespaceTable } from "@kozane/core/schema";
import {
  rememberLocalRecoveryCheckpoint,
  rememberSharedRecoveryCheckpoint,
  rememberSharedRecoveryExecutionCheckpoint,
  rememberSharedRecoveryActionCheckpoint,
  rememberSharedRecoveryRetainedCheckpoint,
  rememberRecoveryAssetCheckpoint,
  describeRetainedRecoveryAssets,
  rememberRetainedRecoveryAssetCheckpoint,
  rememberRetainedRecoveryAssetCheckpointInTx,
  readRetainedRecoveryAssetCheckpoint,
  inspectRetainedRecoveryAssetCheckpoint,
  parseRetainedRecoveryAssetCheckpointRecord,
  requireStoredRetainedRecoveryAssetCheckpoint,
  captureLocalRecoverySnapshot,
  validateLocalRecoverySnapshot,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { installCapturePrototype, capturedTables } from "../../test-utils/action-capture.js";
import type { DB as SourceDB } from "../../../../core/src/database.js";
import {
  retainedRecoveryAssetFixture,
  identity,
  clone,
} from "../../test-utils/retained-recovery-assets.js";
const database = async () => (await createTestDB()) as unknown as DB;
const { schemaId: _schemaId, ...key } = identity;
const tables = {
  assets: "local_recovery_retained_assets",
  retained: "local_recovery_retained_history",
  current: "local_recovery_assets",
  originals: "local_recovery_actions",
  executions: "local_recovery_executions",
  shared: "local_recovery_shared_history",
  local: "local_recovery_checkpoint",
} as const;
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(register = true) {
  const source = await retainedRecoveryAssetFixture(),
    db = await database();
  const shared = source.assetCheckpoint.binding.checkpoint,
    local = source.binding.localCheckpoint,
    retained = source.binding.checkpoint,
    original = retained.checkpoint,
    execution = original.checkpoint;
  await rememberLocalRecoveryCheckpoint(db, local);
  await rememberSharedRecoveryCheckpoint(db, shared);
  await rememberSharedRecoveryExecutionCheckpoint(db, execution);
  await rememberSharedRecoveryActionCheckpoint(db, original);
  await rememberSharedRecoveryRetainedCheckpoint(db, retained);
  await rememberRecoveryAssetCheckpoint(db, source.assetCheckpoint);
  const assets = await describeRetainedRecoveryAssets(source);
  if (register) await rememberRetainedRecoveryAssetCheckpoint(db, assets.checkpoint);
  return {
    db,
    source,
    assets,
    local,
    shared,
    retained,
    original,
    execution,
    inspect: () => inspectRetainedRecoveryAssetCheckpoint(db, key),
    require: (input: unknown = assets.payload) =>
      requireStoredRetainedRecoveryAssetCheckpoint(db, input, identity, source),
  };
}
it("registers idempotently and reads exact expectations without timestamp conversion", async () => {
  const f = await fixture(false);
  expect(await f.inspect()).toBeNull();
  expect(await rememberRetainedRecoveryAssetCheckpoint(f.db, f.assets.checkpoint)).toEqual({
    checkpoint: f.assets.checkpoint,
    changed: true,
  });
  await f.db.run(sql`UPDATE local_recovery_retained_assets SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_assets`,
  );
  expect(await rememberRetainedRecoveryAssetCheckpoint(f.db, f.assets.checkpoint)).toEqual({
    checkpoint: f.assets.checkpoint,
    changed: false,
  });
  expect(await f.inspect()).toEqual(f.assets.checkpoint);
  expect(await withReadTx(f.db, (tx) => readRetainedRecoveryAssetCheckpoint(tx, key))).toEqual(
    f.assets.checkpoint,
  );
  expect(
    await f.db.values(
      sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_assets`,
    ),
  ).toEqual(before);
  expect(await f.require()).toEqual(f.assets.payload);
});
it.each(["retained", "current", "originals", "executions", "shared", "local"] as const)(
  "requires live %s even for idempotent registration",
  async (source) => {
    const f = await fixture();
    await f.db.run(sql.raw(`DELETE FROM ${tables[source]}`));
    expect(await f.inspect()).toEqual(f.assets.checkpoint);
    await expect(
      rememberRetainedRecoveryAssetCheckpoint(f.db, f.assets.checkpoint),
    ).rejects.toThrow();
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.require()).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["hash", "length", "inventory", "current-hash", "local-binding"])(
  "refuses changed %s under an existing key",
  async (change) => {
    const f = await fixture(),
      cp = clone(f.assets.checkpoint);
    if (change === "hash") cp.sha256 = "b".repeat(64);
    if (change === "length") cp.byteLength++;
    if (change === "inventory") {
      cp.binding.checkpoint.selection.effectSets[0].source = "rebase";
      await f.db.run(
        sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify(cp.binding.checkpoint)}`,
      );
    }
    if (change === "current-hash") {
      cp.assetCheckpoint.sha256 = "b".repeat(64);
      await f.db.run(
        sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(cp.assetCheckpoint)}`,
      );
    }
    if (change === "local-binding") {
      cp.binding.localCheckpoint.sha256 = "b".repeat(64);
      cp.assetCheckpoint.binding.localCheckpoint.sha256 = "b".repeat(64);
      const local = JSON.stringify(cp.binding.localCheckpoint);
      await f.db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${local}`);
      for (const table of [tables.retained, tables.originals, tables.executions, tables.shared])
        await f.db.run(sql`UPDATE ${sql.raw(table)} SET local_descriptor=${local}`);
      await f.db.run(
        sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(cp.assetCheckpoint)}`,
      );
    }
    await expect(rememberRetainedRecoveryAssetCheckpoint(f.db, cp)).rejects.toThrow(
      "different contents or bindings",
    );
    expect(await f.inspect()).toEqual(f.assets.checkpoint);
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps %s keys independent",
  async (field) => {
    const f = await fixture(),
      cp = clone(f.assets.checkpoint),
      other = { ...identity, [field]: "other" };
    cp.binding.localCheckpoint.identity = other;
    cp.binding.checkpoint.checkpoint.checkpoint.checkpoint.identity = other;
    cp.assetCheckpoint.binding.checkpoint.identity = other;
    cp.assetCheckpoint.binding.localCheckpoint.identity = other;
    await rememberLocalRecoveryCheckpoint(f.db, cp.binding.localCheckpoint);
    await rememberSharedRecoveryCheckpoint(f.db, cp.assetCheckpoint.binding.checkpoint);
    await rememberSharedRecoveryExecutionCheckpoint(
      f.db,
      cp.binding.checkpoint.checkpoint.checkpoint,
    );
    await rememberSharedRecoveryActionCheckpoint(f.db, cp.binding.checkpoint.checkpoint);
    await rememberSharedRecoveryRetainedCheckpoint(f.db, cp.binding.checkpoint);
    await rememberRecoveryAssetCheckpoint(f.db, cp.assetCheckpoint);
    await rememberRetainedRecoveryAssetCheckpoint(f.db, cp);
    expect(
      await inspectRetainedRecoveryAssetCheckpoint(f.db, { ...key, [field]: "other" }),
    ).toEqual(cp);
    expect(await f.inspect()).toEqual(f.assets.checkpoint);
  },
);
it("copies registration input before the write boundary", async () => {
  const f = await fixture(false),
    input = clone(f.assets.checkpoint),
    writing = rememberRetainedRecoveryAssetCheckpoint(f.db, input);
  input.sha256 = "b".repeat(64);
  input.binding.checkpoint.selection.effectSets.length = 0;
  expect((await writing).checkpoint).toEqual(f.assets.checkpoint);
});
it.each(["statement", "commit"])(
  "rolls back registration and dependent writes after %s failure",
  async (mode) => {
    const f = await fixture(false);
    await f.db.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (mode === "commit") {
      await f.db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.db.run(
        sql`CREATE TRIGGER reject_assets AFTER INSERT ON local_recovery_retained_assets BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_assets BEFORE INSERT ON local_recovery_retained_assets BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(
      withTx(f.db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberRetainedRecoveryAssetCheckpointInTx(tx, f.assets.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.db.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.db.run(sql`DROP TRIGGER reject_assets`);
    await rememberRetainedRecoveryAssetCheckpoint(f.db, f.assets.checkpoint);
  },
);
it("resolves trusted expectations before hashing and rejects altered per-run requirements", async () => {
  const f = await fixture(false),
    digest = vi.spyOn(crypto.subtle, "digest");
  await expect(f.require()).rejects.toThrow("not registered");
  expect(digest).not.toHaveBeenCalled();
  await rememberRetainedRecoveryAssetCheckpoint(f.db, f.assets.checkpoint);
  const payload = clone(f.assets.payload);
  payload.history.effectSets[0].history.effectSets[0].manifest.entries.pop();
  await expect(f.require(payload)).rejects.toThrow("content mismatch");
  expect(await f.require()).toEqual(f.assets.payload);
});
it.each(Object.keys(tables) as (keyof typeof tables)[])(
  "rechecks %s after removal or mutation during hashing",
  async (source) => {
    for (const remove of [false, true]) {
      const f = await fixture(),
        digest = crypto.subtle.digest.bind(crypto.subtle),
        cp = {
          assets: f.assets.checkpoint,
          retained: f.retained,
          current: f.source.assetCheckpoint,
          originals: f.original,
          executions: f.execution,
          shared: f.shared,
          local: f.local,
        };
      vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
        await f.db.run(
          remove
            ? sql.raw(`DELETE FROM ${tables[source]}`)
            : sql`UPDATE ${sql.raw(tables[source])} SET descriptor=${JSON.stringify({ ...cp[source], sha256: "b".repeat(64) })}`,
        );
        return digest(...args);
      });
      await expect(f.require()).rejects.toThrow();
      vi.restoreAllMocks();
    }
  },
);
it.each(["retained", "originals", "executions", "shared"] as const)(
  "rechecks the exact %s local binding after hashing",
  async (source) => {
    const f = await fixture(),
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      await f.db.run(
        sql`UPDATE ${sql.raw(tables[source])} SET local_descriptor=${JSON.stringify({ ...f.local, sha256: "b".repeat(64) })}`,
      );
      return digest(...args);
    });
    await expect(f.require()).rejects.toThrow();
  },
);
it("refuses coherent replacement of all seven expectations after hashing", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const local = { ...f.local, sha256: "b".repeat(64) },
      shared = { ...f.shared, sha256: "c".repeat(64) },
      execution = { ...f.execution, checkpoint: shared },
      original = { ...f.original, checkpoint: execution },
      retained = { ...f.retained, checkpoint: original },
      current = {
        ...f.source.assetCheckpoint,
        binding: { checkpoint: shared, localCheckpoint: local },
      },
      assets = {
        ...f.assets.checkpoint,
        binding: { checkpoint: retained, localCheckpoint: local },
        assetCheckpoint: current,
      };
    await withTx(f.db, async (tx) => {
      await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(local)}`);
      for (const [table, cp] of [
        [tables.shared, shared],
        [tables.executions, execution],
        [tables.originals, original],
        [tables.retained, retained],
      ] as const)
        await tx.run(
          sql`UPDATE ${sql.raw(table)} SET descriptor=${JSON.stringify(cp)},local_descriptor=${JSON.stringify(local)}`,
        );
      await tx.run(sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(current)}`);
      await tx.run(
        sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(assets)}`,
      );
    });
    return digest(...args);
  });
  await expect(f.require()).rejects.toThrow("changed during verification");
});
it("allows unrelated registrations and equivalent JSON formatting outside catalog reads", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    await rememberLocalRecoveryCheckpoint(f.db, {
      ...f.local,
      identity: { ...identity, checkpointId: "other" },
    });
    await f.db.run(
      sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(f.assets.checkpoint, null, 2)}`,
    );
    return digest(...args);
  });
  expect(await f.require()).toEqual(f.assets.payload);
});
it("owns all six sources before the first catalog read yields", async () => {
  const f = await fixture(),
    payload = clone(f.assets.payload),
    source = clone(f.source),
    expected = { ...identity };
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, (tx) => {
        payload.history.effectSets.length = 0;
        source.localSnapshot.tables.length = 0;
        source.sharedHistory.history.effectSets.length = 0;
        source.executions.effectSets.length = 0;
        source.originalActions.actions.length = 0;
        source.retainedHistory.effectSets.length = 0;
        source.currentAssets.manifest.entries.length = 0;
        expected.deviceId = "changed";
        return work(tx as unknown as DatabaseHandle);
      }),
  });
  expect(
    await requireStoredRetainedRecoveryAssetCheckpoint(wrapped, payload, expected, source),
  ).toEqual(f.assets.payload);
});
it("preserves exact metadata through shared replacement and isolated local validation", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE local_recovery_retained_assets SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_assets`,
  );
  expect(capturedTables.some(({ name }) => name === tables.assets)).toBe(false);
  const capture = await installCapturePrototype(f.db as unknown as SourceDB);
  await capture.restore(async () => (await database()) as unknown as SourceDB, []);
  expect(
    await f.db.values(
      sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_assets`,
    ),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => f.local.selection,
  );
  expect(snapshot.tables).toHaveLength(14);
  expect(snapshot.tables.find(({ name }) => name === tables.assets)!.rows[0].created_at).toEqual([
    "integer",
    "9223372036854775807",
  ]);
  const target = await database();
  await validateLocalRecoverySnapshot(async () => target, snapshot, snapshot.identity);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_retained_assets`)).toEqual([]);
});
it.each(["hash", "inventory", "local-selection"])(
  "refuses malformed %s metadata before allocating local validation SQL",
  async (change) => {
    const f = await fixture(),
      cp = clone(f.assets.checkpoint);
    if (change === "hash") cp.sha256 = "bad";
    if (change === "inventory") cp.binding.checkpoint.selection.effectSets.pop();
    if (change === "local-selection") cp.binding.localCheckpoint.selection.effectSetIds = [];
    await f.db.run(sql`UPDATE local_recovery_retained_assets SET descriptor=${JSON.stringify(cp)}`);
    await expect(f.inspect()).rejects.toThrow();
    const snapshot = await captureLocalRecoverySnapshot(
        f.db,
        { ...identity, checkpointId: "later" },
        async () => f.local.selection,
      ),
      create = vi.fn(database);
    await expect(
      validateLocalRecoverySnapshot(create, snapshot, snapshot.identity),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([
  "key",
  "version",
  "retained-version",
  "local-version",
  "asset-version",
  "local-key",
  "retained-key",
  "asset-key",
  "asset-local-key",
  "asset-local-schema",
])("enforces %s SQL descriptor constraints", async (change) => {
  const f = await fixture(false),
    cp = clone(f.assets.checkpoint);
  if (change === "version") cp.version = 2;
  if (change === "retained-version") cp.binding.checkpoint.version = 2;
  if (change === "local-version") cp.binding.localCheckpoint.version = 2;
  if (change === "asset-version") cp.assetCheckpoint.version = 2;
  if (change === "local-key") cp.binding.localCheckpoint.identity.deviceId = "other";
  if (change === "retained-key")
    cp.binding.checkpoint.checkpoint.checkpoint.checkpoint.identity.deviceId = "other";
  if (change === "asset-key") cp.assetCheckpoint.binding.checkpoint.identity.deviceId = "other";
  if (change === "asset-local-key")
    cp.assetCheckpoint.binding.localCheckpoint.identity.deviceId = "other";
  if (change === "asset-local-schema")
    cp.assetCheckpoint.binding.localCheckpoint.identity.schemaId = migrations.at(-2)!.id;
  await expect(
    f.db.insert(localRecoveryRetainedAssetsTable).values({
      ...key,
      checkpointId: change === "key" ? "other" : key.checkpointId,
      descriptor: JSON.stringify(cp),
      createdAt: new Date(0),
    }),
  ).rejects.toThrow();
});
it("retains historical and orphaned expectations without authorizing old-schema loading", async () => {
  const f = await fixture(false),
    cp = clone(f.assets.checkpoint),
    old = { ...identity, schemaId: migrations.at(-2)!.id };
  cp.binding.localCheckpoint.identity = old;
  cp.binding.checkpoint.checkpoint.checkpoint.checkpoint.identity = old;
  cp.assetCheckpoint.binding.checkpoint.identity = old;
  cp.assetCheckpoint.binding.localCheckpoint.identity = old;
  for (const table of Object.values(tables)) await f.db.run(sql.raw(`DELETE FROM ${table}`));
  await rememberLocalRecoveryCheckpoint(f.db, cp.binding.localCheckpoint);
  await rememberSharedRecoveryCheckpoint(f.db, cp.assetCheckpoint.binding.checkpoint);
  await rememberSharedRecoveryExecutionCheckpoint(
    f.db,
    cp.binding.checkpoint.checkpoint.checkpoint,
  );
  await rememberSharedRecoveryActionCheckpoint(f.db, cp.binding.checkpoint.checkpoint);
  await rememberSharedRecoveryRetainedCheckpoint(f.db, cp.binding.checkpoint);
  await rememberRecoveryAssetCheckpoint(f.db, cp.assetCheckpoint);
  await rememberRetainedRecoveryAssetCheckpoint(f.db, cp);
  for (const [name, table] of Object.entries(tables))
    if (name !== "assets") await f.db.run(sql.raw(`DELETE FROM ${table}`));
  expect(await f.inspect()).toEqual(cp);
  expect(() =>
    parseRetainedRecoveryAssetCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(cp),
    ),
  ).toThrow("identity mismatch");
  expect(() => parseRetainedRecoveryAssetCheckpointRecord(key, {})).toThrow("TEXT");
  await expect(
    requireStoredRetainedRecoveryAssetCheckpoint(f.db, f.assets.payload, old, f.source),
  ).rejects.toThrow("Unsupported");
});
it.each([false, true])(
  "migration 33 preserves source metadata and rolls back failed upgrades (rollback=%s)",
  async (fail) => {
    const f = await fixture(false),
      migration = migrations.find(({ id }) => id === "0033_local_recovery_retained_assets")!;
    await withMigration(f.db, async () => [
      { sql: "DROP TABLE shared_only_recovery_installation", args: [] },
      { sql: "DROP TABLE shared_recovery_installation", args: [] },
      { sql: "DROP TABLE local_recovery_installation", args: [] },
      { sql: "DROP TABLE local_recovery_run_assets", args: [] },
      { sql: "DROP TABLE local_recovery_run_archives", args: [] },
      { sql: "DROP TABLE local_recovery_action_archives", args: [] },
      { sql: "DROP TABLE local_recovery_retained_assets", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      {
        sql: "UPDATE local_recovery_retained_history SET created_at=9223372036854775807",
        args: [],
      },
    ]);
    const before = await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
    );
    if (fail) {
      await f.db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(f.db)).rejects.toThrow();
      await expect(
        f.db.values(sql`SELECT 1 FROM local_recovery_retained_assets`),
      ).rejects.toThrow();
      await f.db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.db)).appliedIds).toEqual(
      migrations.filter((m) => m.idx >= migration.idx).map((m) => m.id),
    );
    expect(
      await f.db.values(
        sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
      ),
    ).toEqual(before);
    await rememberRetainedRecoveryAssetCheckpoint(f.db, f.assets.checkpoint);
  },
);
