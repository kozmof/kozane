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
import { namespaceTable, localRecoveryExecutionsTable } from "../../../../core/src/schema.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
import { captureLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-checkpoint.js";
import { rememberLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-store.js";
import { rememberSharedRecoveryCheckpoint } from "../../../../core/src/actions/shared-recovery-store.js";
import { validateLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-validation.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import { describeSharedRecoveryExecutions } from "../../../../core/src/actions/shared-recovery-executions.js";
import {
  inspectSharedRecoveryExecutionCheckpoint,
  rememberSharedRecoveryExecutionCheckpoint,
  rememberSharedRecoveryExecutionCheckpointInTx,
  parseSharedRecoveryExecutionCheckpointRecord,
  requireStoredSharedRecoveryExecutionCheckpoint,
} from "../../../../core/src/actions/shared-recovery-execution-store.js";
const database = async () => (await createTestDB()) as unknown as DB;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const selection = { baselineId: "baseline", effectSetIds: ["empty"] };
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
  await rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  const root = {
    id: "root",
    kind: "future.root",
    contractVersion: 99,
    input: { args: {}, body: { note: "original" } },
  };
  const child = {
    id: "child",
    kind: "future.child",
    contractVersion: 99,
    input: { ref: "kozane-image:/api/images/00000000-0000-4000-8000-000000000001.svg" },
  };
  const generated = { child: { type: "child-id", value: "child" } };
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [{ id: "empty", rootId: "root", executionCount: 2 }],
    },
    effectSets: [
      {
        id: "empty",
        invocation: root,
        generated,
        executions: [
          { ...root, parentId: null, executionOrd: 0, generated },
          { ...child, parentId: "root", executionOrd: 1, generated: {} },
        ],
        effects: [],
      },
    ],
  });
  if (register) await rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  return {
    db,
    local,
    shared,
    executions,
    inspect: () => inspectSharedRecoveryExecutionCheckpoint(db, key),
    require: (input: unknown = executions.payload) =>
      requireStoredSharedRecoveryExecutionCheckpoint(db, input, identity, shared.payload),
  };
}
it("registers immutable execution and local expectations idempotently without converting timestamps", async () => {
  const f = await fixture(false);
  expect(await f.inspect()).toBeNull();
  const binding = { checkpoint: f.executions.checkpoint, localCheckpoint: f.local.checkpoint };
  expect(await rememberSharedRecoveryExecutionCheckpoint(f.db, f.executions.checkpoint)).toEqual({
    binding,
    changed: true,
  });
  await f.db.run(sql`UPDATE local_recovery_executions SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
  );
  expect(await rememberSharedRecoveryExecutionCheckpoint(f.db, f.executions.checkpoint)).toEqual({
    binding,
    changed: false,
  });
  expect(await f.inspect()).toEqual(binding);
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
    ),
  ).toEqual(before);
});
it.each(["missing-shared", "missing-local", "changed-shared", "changed-local"])(
  "requires matching original source bindings before registration (%s)",
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
    await expect(
      rememberSharedRecoveryExecutionCheckpoint(f.db, f.executions.checkpoint),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
  },
);
it.each(["hash", "length", "count", "root", "source", "local-binding"])(
  "refuses changed %s under an existing key",
  async (change) => {
    const f = await fixture(),
      input = clone(f.executions.checkpoint);
    if (change === "hash") input.sha256 = "b".repeat(64);
    if (change === "length") input.byteLength++;
    if (change === "count") input.selection.effectSets[0].executionCount++;
    if (change === "root") input.selection.effectSets[0].rootId = "other-root";
    if (change === "source") {
      input.checkpoint.sha256 = "b".repeat(64);
      await f.db.run(
        sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(input.checkpoint)}`,
      );
    }
    if (change === "local-binding") {
      const local = JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) });
      await f.db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${local}`);
      await f.db.run(sql`UPDATE local_recovery_shared_history SET local_descriptor=${local}`);
    }
    await expect(rememberSharedRecoveryExecutionCheckpoint(f.db, input)).rejects.toThrow(
      "different contents or bindings",
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.executions.checkpoint);
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps independent %s keys separate",
  async (field) => {
    const f = await fixture(),
      other = { ...identity, [field]: "other" };
    const local = { ...f.local.checkpoint, identity: other },
      shared = { ...f.shared.checkpoint, identity: other };
    await rememberLocalRecoveryCheckpoint(f.db, local);
    await rememberSharedRecoveryCheckpoint(f.db, shared);
    const checkpoint = { ...f.executions.checkpoint, checkpoint: shared };
    await rememberSharedRecoveryExecutionCheckpoint(f.db, checkpoint);
    expect(
      await inspectSharedRecoveryExecutionCheckpoint(f.db, { ...key, [field]: "other" }),
    ).toEqual({ checkpoint, localCheckpoint: local });
    expect((await f.inspect())!.checkpoint).toEqual(f.executions.checkpoint);
  },
);
it("copies registration input before opening its writer boundary", async () => {
  const f = await fixture(false),
    input = clone(f.executions.checkpoint);
  const writing = rememberSharedRecoveryExecutionCheckpoint(f.db, input);
  input.sha256 = "b".repeat(64);
  input.selection.effectSets.length = 0;
  input.checkpoint.identity.deviceId = "changed";
  expect((await writing).binding.checkpoint).toEqual(f.executions.checkpoint);
});
it.each([false, true])(
  "rolls back execution registration and dependent changes together (commit=%s)",
  async (commit) => {
    const f = await fixture(false);
    await f.db.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (commit) {
      await f.db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.db.run(
        sql`CREATE TRIGGER reject_executions AFTER INSERT ON local_recovery_executions BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_executions BEFORE INSERT ON local_recovery_executions BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(
      withTx(f.db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberSharedRecoveryExecutionCheckpointInTx(tx, f.executions.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.db.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.db.run(sql`DROP TRIGGER reject_executions`);
    await rememberSharedRecoveryExecutionCheckpoint(f.db, f.executions.checkpoint);
  },
);
it("retains orphaned expectations for inspection while refusing registration and verification", async () => {
  const f = await fixture();
  await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
  await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
  expect((await f.inspect())!.checkpoint).toEqual(f.executions.checkpoint);
  await expect(f.require()).rejects.toThrow("missing or changed");
  await expect(
    rememberSharedRecoveryExecutionCheckpoint(f.db, f.executions.checkpoint),
  ).rejects.toThrow("not registered");
});
it("resolves trusted execution expectations instead of accepting transported counts or inputs", async () => {
  const f = await fixture();
  expect(await f.require()).toEqual(f.executions.payload);
  const changed = clone(f.executions.payload);
  changed.effectSets[0].executions[1].input.ref = "changed";
  await expect(f.require(changed)).rejects.toThrow("content mismatch");
  const truncated = clone(f.executions.payload);
  truncated.effectSets[0].executions.pop();
  truncated.selection.effectSets[0].executionCount--;
  await expect(f.require(truncated)).rejects.toThrow("binding mismatch");
});
it("requires a retained execution descriptor before hashing", async () => {
  const f = await fixture(false),
    digest = vi.spyOn(crypto.subtle, "digest");
  await expect(f.require()).rejects.toThrow("not registered");
  expect(digest).not.toHaveBeenCalled();
});
it.each([
  "removed-execution",
  "changed-execution",
  "removed-shared",
  "changed-shared",
  "removed-local",
  "changed-local",
  "changed-bound-local",
  "rebound-all",
])("refuses %s during hashing", async (change) => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    if (change === "removed-execution") await f.db.run(sql`DELETE FROM local_recovery_executions`);
    if (change === "changed-execution")
      await f.db.run(
        sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...f.executions.checkpoint, sha256: "b".repeat(64) })}`,
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
    if (change === "changed-bound-local")
      await f.db.run(
        sql`UPDATE local_recovery_executions SET local_descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "rebound-all") {
      const local = { ...f.local.checkpoint, sha256: "b".repeat(64) },
        shared = { ...f.shared.checkpoint, sha256: "c".repeat(64) };
      await withTx(f.db, async (tx) => {
        await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(local)}`);
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(shared)},local_descriptor=${JSON.stringify(local)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...f.executions.checkpoint, checkpoint: shared })},local_descriptor=${JSON.stringify(local)}`,
        );
      });
    }
    return digest(...args);
  });
  await expect(f.require()).rejects.toThrow();
});
it("permits unrelated registrations and equivalent JSON formatting outside catalog reads", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const identity2 = { ...identity, checkpointId: "other" },
      local = { ...f.local.checkpoint, identity: identity2 },
      shared = { ...f.shared.checkpoint, identity: identity2 };
    await rememberLocalRecoveryCheckpoint(f.db, local);
    await rememberSharedRecoveryCheckpoint(f.db, shared);
    await rememberSharedRecoveryExecutionCheckpoint(f.db, {
      ...f.executions.checkpoint,
      checkpoint: shared,
    });
    await f.db.run(
      sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(f.executions.checkpoint, null, 2)},local_descriptor=${JSON.stringify(f.local.checkpoint, null, 2)} WHERE checkpoint_id=${key.checkpointId}`,
    );
    return digest(...args);
  });
  expect(await f.require()).toEqual(f.executions.payload);
});
it("owns execution input, source rows and expected identity before the first catalog read yields", async () => {
  const f = await fixture(),
    input = clone(f.executions.payload),
    source = clone(f.shared.payload),
    expected = { ...identity };
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw new Error("Unexpected source write");
    },
    read: (operation) =>
      withReadTx(f.db, (tx) => {
        input.effectSets.length = 0;
        source.history.effectSets.length = 0;
        expected.deviceId = "changed";
        return operation(tx as unknown as DatabaseHandle);
      }),
  });
  expect(
    await requireStoredSharedRecoveryExecutionCheckpoint(wrapped, input, expected, source),
  ).toEqual(f.executions.payload);
});
it("preserves exact execution records through shared restoration and isolated local validation", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE local_recovery_executions SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
  );
  expect(capturedTables.some(({ name }) => name === "local_recovery_executions")).toBe(false);
  const capture = await installCapturePrototype(f.db);
  await capture.restore(database, []);
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
    ),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => selection,
  );
  expect(snapshot.tables).toHaveLength(14);
  expect(
    snapshot.tables.find(({ name }) => name === "local_recovery_executions")!.rows[0].created_at,
  ).toEqual(["integer", "9223372036854775807"]);
  const target = await database();
  await validateLocalRecoverySnapshot(async () => target, snapshot, snapshot.identity);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_executions`)).toEqual([]);
});
it("rejects malformed nested descriptors before allocating validation SQL", async () => {
  const f = await fixture();
  await f.db.run(
    sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...f.executions.checkpoint, sha256: "bad" })}`,
  );
  await expect(f.inspect()).rejects.toThrow();
  const snapshot = await captureLocalRecoverySnapshot(
      f.db,
      { ...identity, checkpointId: "later" },
      async () => selection,
    ),
    create = vi.fn(database);
  await expect(
    validateLocalRecoverySnapshot(create, snapshot, snapshot.identity),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it("checks row identity, original local coherence and SQL descriptor constraints", async () => {
  const f = await fixture();
  expect(() =>
    parseSharedRecoveryExecutionCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(f.executions.checkpoint),
      JSON.stringify(f.local.checkpoint),
    ),
  ).toThrow("identity mismatch");
  expect(() =>
    parseSharedRecoveryExecutionCheckpointRecord(key, {}, JSON.stringify(f.local.checkpoint)),
  ).toThrow("TEXT");
  expect(() =>
    parseSharedRecoveryExecutionCheckpointRecord(
      key,
      JSON.stringify(f.executions.checkpoint),
      JSON.stringify({ ...f.local.checkpoint, selection: { ...selection, baselineId: "other" } }),
    ),
  ).toThrow("does not match");
  await f.db.run(sql`DELETE FROM local_recovery_executions`);
  for (const change of ["key", "version", "source-version", "local-identity", "local-schema"]) {
    const descriptor = clone(f.executions.checkpoint),
      local = clone(f.local.checkpoint);
    if (change === "version") descriptor.version = 2;
    if (change === "source-version") descriptor.checkpoint.version = 2;
    if (change === "local-identity") local.identity.deviceId = "other";
    if (change === "local-schema") local.identity.schemaId = migrations.at(-2)!.id;
    await expect(
      f.db.insert(localRecoveryExecutionsTable).values({
        ...key,
        checkpointId: change === "key" ? "other" : key.checkpointId,
        descriptor: JSON.stringify(descriptor),
        localDescriptor: JSON.stringify(local),
        createdAt: new Date(0),
      }),
    ).rejects.toThrow();
  }
});
it("retains historical execution expectations as metadata without loading old-schema payloads", async () => {
  const f = await fixture(false),
    old = { ...identity, schemaId: migrations.at(-2)!.id };
  await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
  await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
  const local = { ...f.local.checkpoint, identity: old },
    shared = { ...f.shared.checkpoint, identity: old };
  await rememberLocalRecoveryCheckpoint(f.db, local);
  await rememberSharedRecoveryCheckpoint(f.db, shared);
  const checkpoint = { ...f.executions.checkpoint, checkpoint: shared };
  await rememberSharedRecoveryExecutionCheckpoint(f.db, checkpoint);
  expect(await f.inspect()).toEqual({ checkpoint, localCheckpoint: local });
  await expect(
    requireStoredSharedRecoveryExecutionCheckpoint(
      f.db,
      f.executions.payload,
      old,
      f.shared.payload,
    ),
  ).rejects.toThrow("Unsupported");
});
it.each([false, true])(
  "migration 30 preserves earlier checkpoint catalogs and rolls back on failure (rollback=%s)",
  async (fail) => {
    const f = await fixture(false),
      migration = migrations.find(({ tag }) => tag === "0030_local_recovery_executions")!;
    await withMigration(f.db, async () => [
      { sql: "DROP TABLE local_recovery_run_assets", args: [] },
      { sql: "DROP TABLE local_recovery_run_archives", args: [] },
      { sql: "DROP TABLE local_recovery_action_archives", args: [] },
      { sql: "DROP TABLE local_recovery_retained_assets", args: [] },
      { sql: "DROP TABLE local_recovery_retained_history", args: [] },
      { sql: "DROP TABLE local_recovery_actions", args: [] },
      { sql: "DROP TABLE local_recovery_executions", args: [] },
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
      await expect(f.db.values(sql`SELECT 1 FROM local_recovery_executions`)).rejects.toThrow();
      await f.db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.db)).appliedIds).toEqual(
      migrations.filter(({ idx }) => idx >= migration.idx).map(({ id }) => id),
    );
    expect(
      await f.db.values(
        sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
      ),
    ).toEqual(before);
    await rememberSharedRecoveryExecutionCheckpoint(f.db, f.executions.checkpoint);
  },
);
