import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { capturedTables, installCapturePrototype } from "../../test-utils/action-capture.js";
import {
  withTx,
  withReadTx,
  withMigration,
  createDatabaseAdapter,
  type DB,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { applyMigrations } from "../../../../core/src/migrations/apply.js";
import { namespaceTable, localRecoveryAssetsTable } from "../../../../core/src/schema.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
import { captureLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-checkpoint.js";
import { rememberLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-store.js";
import { rememberSharedRecoveryCheckpoint } from "../../../../core/src/actions/shared-recovery-store.js";
import { validateLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-validation.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import { describeRecoveryAssets } from "../../../../core/src/actions/recovery-asset-checkpoint.js";
import {
  inspectRecoveryAssetCheckpoint,
  rememberRecoveryAssetCheckpoint,
  rememberRecoveryAssetCheckpointInTx,
  parseRecoveryAssetCheckpointRecord,
  requireStoredRecoveryAssetCheckpoint,
} from "../../../../core/src/actions/recovery-asset-store.js";

const database = async () => (await createTestDB()) as unknown as DB;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const selection = { baselineId: "baseline", effectSetIds: ["empty"] };
const empty = { version: 1, entries: [] };
const image = {
  version: 1,
  entries: [
    {
      name: ".kozane/assets/images/00000000-0000-4000-8000-000000000001.svg",
      byteLength: 3,
      sha256: "a".repeat(64),
    },
  ],
};
const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(register = true) {
  const db = await database();
  const local = await captureLocalRecoveryCheckpoint(db, identity, async () => selection);
  await rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  const shared = await describeSharedRecoveryHistory(
    {
      baseline: {
        id: "baseline",
        projection: {
          version: 1,
          rowEncodingVersion: 1,
          schemaId: identity.schemaId,
          tables: capturedTables.map(({ name }) => ({ name, rows: [] })),
        },
      },
      effectSets: [{ id: "empty", effects: [] }],
    },
    identity,
    { baselineId: "baseline", effectSets: [{ id: "empty", effectCount: 0 }] },
  );
  const binding = (await rememberSharedRecoveryCheckpoint(db, shared.checkpoint)).binding;
  const contents = { localSnapshot: local.snapshot, sharedHistory: shared.payload };
  const assets = await describeRecoveryAssets({
    ...contents,
    binding,
    history: {
      baseline: { id: "baseline", manifest: empty },
      effectSets: [{ id: "empty", manifest: image }],
    },
  });
  if (register) await rememberRecoveryAssetCheckpoint(db, assets.checkpoint);
  return {
    db,
    local,
    shared,
    assets,
    contents,
    inspect: () => inspectRecoveryAssetCheckpoint(db, key),
    require: (input: unknown = assets.payload) =>
      requireStoredRecoveryAssetCheckpoint(db, input, identity, contents),
  };
}

it("registers the exact descriptor idempotently without reading or rewriting an unsafe timestamp", async () => {
  const f = await fixture(false);
  expect(await f.inspect()).toBeNull();
  expect(await rememberRecoveryAssetCheckpoint(f.db, f.assets.checkpoint)).toEqual({
    checkpoint: f.assets.checkpoint,
    changed: true,
  });
  await f.db.run(sql`UPDATE local_recovery_assets SET created_at=9223372036854775807`);
  const rows = () =>
    f.db.values(sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_assets`);
  const before = await rows();
  expect(await rememberRecoveryAssetCheckpoint(f.db, f.assets.checkpoint)).toEqual({
    checkpoint: f.assets.checkpoint,
    changed: false,
  });
  expect(await f.inspect()).toEqual(f.assets.checkpoint);
  expect(await rows()).toEqual(before);
});

it.each(["missing-shared", "missing-local", "changed-shared", "changed-local"])(
  "requires live matching catalogs before registration (%s)",
  async (change) => {
    const f = await fixture(false);
    if (change === "missing-shared") await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
    if (change === "missing-local") await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "changed-shared")
      await f.db.run(
        sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify({ ...f.shared.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "changed-local")
      await f.db.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    await expect(rememberRecoveryAssetCheckpoint(f.db, f.assets.checkpoint)).rejects.toThrow(
      "missing or changed",
    );
    expect(await f.inspect()).toBeNull();
  },
);

it.each(["hash", "length", "binding"])("refuses replacement of registered %s", async (change) => {
  const f = await fixture();
  const input = clone(f.assets.checkpoint);
  if (change === "hash") input.sha256 = "b".repeat(64);
  if (change === "length") input.byteLength++;
  if (change === "binding") {
    input.binding.checkpoint.sha256 = "b".repeat(64);
    await f.db.run(
      sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(input.binding.checkpoint)}`,
    );
  }
  await expect(rememberRecoveryAssetCheckpoint(f.db, input)).rejects.toThrow(
    "different contents or bindings",
  );
  expect(await f.inspect()).toEqual(f.assets.checkpoint);
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps independent %s registrations separate",
  async (field) => {
    const f = await fixture();
    const other = { ...identity, [field]: "other" };
    const local = { ...f.local.checkpoint, identity: other };
    const shared = { ...f.shared.checkpoint, identity: other };
    await rememberLocalRecoveryCheckpoint(f.db, local);
    const { binding } = await rememberSharedRecoveryCheckpoint(f.db, shared);
    await rememberRecoveryAssetCheckpoint(f.db, { ...f.assets.checkpoint, binding });
    expect(
      (await inspectRecoveryAssetCheckpoint(f.db, { ...key, [field]: "other" }))!.binding.checkpoint
        .identity,
    ).toEqual(other);
    expect(await f.inspect()).toEqual(f.assets.checkpoint);
  },
);

it("owns registration data before opening its write transaction", async () => {
  const f = await fixture(false);
  const input = clone(f.assets.checkpoint);
  const writing = rememberRecoveryAssetCheckpoint(f.db, input);
  input.sha256 = "b".repeat(64);
  input.binding.localCheckpoint.sha256 = "b".repeat(64);
  expect((await writing).checkpoint).toEqual(f.assets.checkpoint);
});

it.each([false, true])(
  "rolls back registration and dependent changes together (commit=%s)",
  async (commit) => {
    const f = await fixture(false);
    await f.db.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (commit) {
      await f.db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.db.run(
        sql`CREATE TRIGGER reject_assets AFTER INSERT ON local_recovery_assets BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_assets BEFORE INSERT ON local_recovery_assets BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(
      withTx(f.db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberRecoveryAssetCheckpointInTx(tx, f.assets.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.db.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.db.run(sql`DROP TRIGGER reject_assets`);
    await rememberRecoveryAssetCheckpoint(f.db, f.assets.checkpoint);
  },
);

it("preserves orphaned expectations for inspection while refusing registration and loading", async () => {
  const f = await fixture();
  await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
  await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
  expect(await f.inspect()).toEqual(f.assets.checkpoint);
  await expect(f.require()).rejects.toThrow("missing or changed");
  await expect(rememberRecoveryAssetCheckpoint(f.db, f.assets.checkpoint)).rejects.toThrow(
    "missing or changed",
  );
});

it("resolves trusted expectations rather than accepting a payload's changed manifests", async () => {
  const f = await fixture();
  expect(await f.require()).toEqual(f.assets.payload);
  const changed = clone(f.assets.payload);
  changed.history.effectSets[0].manifest = empty;
  changed.manifest = empty;
  await expect(f.require(changed)).rejects.toThrow("content mismatch");
});

it("requires a registered asset expectation before hashing", async () => {
  const f = await fixture(false);
  const digest = vi.spyOn(crypto.subtle, "digest");
  await expect(f.require()).rejects.toThrow("not registered");
  expect(digest).not.toHaveBeenCalled();
});

it.each([
  "removed-assets",
  "changed-assets",
  "removed-shared",
  "changed-shared",
  "removed-local",
  "changed-local",
  "rebound-all",
])("rechecks %s during hashing", async (change) => {
  const f = await fixture();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    if (change === "removed-assets") await f.db.run(sql`DELETE FROM local_recovery_assets`);
    if (change === "changed-assets")
      await f.db.run(
        sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...f.assets.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "removed-shared") await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
    if (change === "changed-shared")
      await f.db.run(
        sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify({ ...f.shared.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "removed-local") await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "changed-local")
      await f.db.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "rebound-all") {
      const localCheckpoint = { ...f.local.checkpoint, sha256: "d".repeat(64) };
      const checkpoint = { ...f.shared.checkpoint, sha256: "e".repeat(64) };
      const binding = { checkpoint, localCheckpoint };
      await withTx(f.db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(localCheckpoint)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(checkpoint)},local_descriptor=${JSON.stringify(localCheckpoint)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...f.assets.checkpoint, binding })}`,
        );
      });
    }
    return digest(...args);
  });
  await expect(f.require()).rejects.toThrow();
});

it("allows unrelated registrations and equivalent JSON formatting during verification", async () => {
  const f = await fixture();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const other = { ...identity, checkpointId: "other" };
    await rememberLocalRecoveryCheckpoint(f.db, { ...f.local.checkpoint, identity: other });
    const { binding } = await rememberSharedRecoveryCheckpoint(f.db, {
      ...f.shared.checkpoint,
      identity: other,
    });
    await rememberRecoveryAssetCheckpoint(f.db, { ...f.assets.checkpoint, binding });
    await f.db.run(
      sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(f.assets.checkpoint, null, 2)} WHERE checkpoint_id=${key.checkpointId}`,
    );
    return digest(...args);
  });
  expect(await f.require()).toEqual(f.assets.payload);
});

it("owns payloads, sources and expected identity before the first catalog read yields", async () => {
  const f = await fixture();
  const input = clone(f.assets.payload);
  const contents = clone(f.contents);
  const expected = { ...identity };
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw new Error("Unexpected source write");
    },
    read: (operation) =>
      withReadTx(f.db, (tx) => {
        input.manifest.entries.length = 0;
        contents.localSnapshot.selection.effectSetIds.length = 0;
        contents.sharedHistory.history.effectSets.length = 0;
        expected.deviceId = "changed";
        return operation(tx as unknown as DatabaseHandle);
      }),
  });
  expect(await requireStoredRecoveryAssetCheckpoint(wrapped, input, expected, contents)).toEqual(
    f.assets.payload,
  );
});

it("preserves catalog rows through shared restoration and exact local snapshot validation", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE local_recovery_assets SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_assets`,
  );
  expect(capturedTables.some(({ name }) => name === "local_recovery_assets")).toBe(false);
  const capture = await installCapturePrototype(f.db);
  await capture.restore(database, []);
  expect(
    await f.db.values(sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_assets`),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => selection,
  );
  expect(snapshot.tables).toHaveLength(14);
  expect(
    snapshot.tables.find(({ name }) => name === "local_recovery_assets")!.rows[0].created_at,
  ).toEqual(["integer", "9223372036854775807"]);
  const target = await database();
  await validateLocalRecoverySnapshot(async () => target, snapshot, snapshot.identity);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_assets`)).toEqual([]);
});

it("rejects malformed nested asset descriptors before allocating local validation SQL", async () => {
  const f = await fixture();
  await f.db.run(
    sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...f.assets.checkpoint, sha256: "bad" })}`,
  );
  await expect(f.inspect()).rejects.toThrow();
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => selection,
  );
  const create = vi.fn(database);
  await expect(
    validateLocalRecoverySnapshot(create, snapshot, snapshot.identity),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("checks row identity and enforces SQL descriptor identity constraints", async () => {
  const f = await fixture();
  await f.db.run(sql`DELETE FROM local_recovery_assets`);
  expect(() =>
    parseRecoveryAssetCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(f.assets.checkpoint),
    ),
  ).toThrow("identity mismatch");
  expect(() => parseRecoveryAssetCheckpointRecord(key, {})).toThrow("TEXT");
  for (const change of ["key", "version", "nested-identity"]) {
    const descriptor = clone(f.assets.checkpoint);
    if (change === "version") descriptor.version = 2;
    if (change === "nested-identity")
      descriptor.binding.localCheckpoint.identity.deviceId = "other";
    await expect(
      f.db.insert(localRecoveryAssetsTable).values({
        ...key,
        checkpointId: change === "key" ? "other" : key.checkpointId,
        descriptor: JSON.stringify(descriptor),
        createdAt: new Date(0),
      }),
    ).rejects.toThrow();
  }
});

it("retains historical descriptors as metadata without authorizing old payloads", async () => {
  const f = await fixture(false);
  const oldIdentity = { ...identity, schemaId: migrations.at(-2)!.id };
  await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
  await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
  const local = { ...f.local.checkpoint, identity: oldIdentity };
  await rememberLocalRecoveryCheckpoint(f.db, local);
  const { binding } = await rememberSharedRecoveryCheckpoint(f.db, {
    ...f.shared.checkpoint,
    identity: oldIdentity,
  });
  const checkpoint = { ...f.assets.checkpoint, binding };
  await rememberRecoveryAssetCheckpoint(f.db, checkpoint);
  expect(await f.inspect()).toEqual(checkpoint);
  await expect(
    requireStoredRecoveryAssetCheckpoint(f.db, f.assets.payload, oldIdentity, f.contents),
  ).rejects.toThrow("Unsupported");
});

it.each([false, true])(
  "migration 29 preserves original checkpoint catalogs and rolls back on failure (rollback=%s)",
  async (fail) => {
    const f = await fixture(false);
    const migration = migrations.find(({ tag }) => tag === "0029_local_recovery_assets")!;
    await withMigration(f.db, async () => [
      { sql: "DROP TABLE shared_only_recovery_installation", args: [] },
      { sql: "DROP TABLE shared_recovery_installation", args: [] },
      { sql: "DROP TABLE local_recovery_installation", args: [] },
      { sql: "DROP TABLE local_recovery_run_assets", args: [] },
      { sql: "DROP TABLE local_recovery_run_archives", args: [] },
      { sql: "DROP TABLE local_recovery_action_archives", args: [] },
      { sql: "DROP TABLE local_recovery_retained_assets", args: [] },
      { sql: "DROP TABLE local_recovery_retained_history", args: [] },
      { sql: "DROP TABLE local_recovery_actions", args: [] },
      { sql: "DROP TABLE local_recovery_executions", args: [] },
      { sql: "DROP TABLE local_recovery_assets", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      { sql: "UPDATE local_recovery_checkpoint SET created_at=9223372036854775807", args: [] },
    ]);
    const before = await f.db.values(
      sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
    );
    if (fail) {
      await f.db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(f.db)).rejects.toThrow();
      await expect(f.db.values(sql`SELECT 1 FROM local_recovery_assets`)).rejects.toThrow();
      await f.db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.db)).appliedIds).toEqual(
      migrations.slice(migration.idx).map(({ id }) => id),
    );
    expect(
      await f.db.values(
        sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
      ),
    ).toEqual(before);
    await rememberRecoveryAssetCheckpoint(f.db, f.assets.checkpoint);
  },
);
