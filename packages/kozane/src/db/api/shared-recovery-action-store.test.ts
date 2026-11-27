import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  withReadTx,
  withTx,
  withMigration,
  createDatabaseAdapter,
  type DB,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations, applyMigrations } from "@kozane/core/migrations";
import { localRecoveryActionsTable, namespaceTable } from "@kozane/core/schema";
import {
  captureLocalRecoveryCheckpoint,
  captureLocalRecoverySnapshot,
  validateLocalRecoverySnapshot,
  rememberLocalRecoveryCheckpoint,
  rememberSharedRecoveryCheckpoint,
  rememberSharedRecoveryExecutionCheckpoint,
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryActions,
  rememberSharedRecoveryActionCheckpoint,
  rememberSharedRecoveryActionCheckpointInTx,
  inspectSharedRecoveryActionCheckpoint,
  readSharedRecoveryActionCheckpoint,
  parseSharedRecoveryActionCheckpointRecord,
  requireStoredSharedRecoveryActionCheckpoint,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import type { DB as SourceDB } from "../../../../core/src/database.js";
import { capturedTables, installCapturePrototype } from "../../test-utils/action-capture.js";
const database = async () => (await createTestDB()) as unknown as DB;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const selected = { baselineId: "baseline", effectSetIds: ["empty"] };
const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(register = true) {
  const db = await database(),
    local = await captureLocalRecoveryCheckpoint(db, identity, async () => selected);
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
    input: { text: '\ufeff{"original":true}\0🪁' },
  };
  const generated = {
    child: { type: "child-id", value: "child" },
    skipped: { type: "child-id", value: "skipped" },
    unused: { type: "entity-id", value: "unused" },
  };
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
          { ...root, parentId: null, executionOrd: 0, generated: { child: generated.child } },
          {
            id: "child",
            kind: "future.child",
            contractVersion: 99,
            input: { text: "later" },
            parentId: "root",
            executionOrd: 1,
            generated: {},
          },
        ],
        effects: [],
      },
    ],
  });
  await rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  const provenance = {
    deviceId: "origin-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
    hlc: "opaque:first-record",
  };
  const originals = await describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: { actionIds: ["root", "child", "skipped"] },
    actions: [
      { ...root, rootId: "root", parentId: null, generated, seq: "1", ...provenance },
      {
        id: "child",
        rootId: "root",
        parentId: "root",
        kind: "future.child",
        contractVersion: 99,
        input: { text: "first" },
        generated: {},
        seq: "2",
        ...provenance,
      },
      {
        id: "skipped",
        rootId: "root",
        parentId: "root",
        kind: "future.skipped",
        contractVersion: 99,
        input: { ref: "kozane-image:/api/images/00000000-0000-4000-8000-000000000001.svg" },
        generated: {},
        seq: "9007199254740993",
        ...provenance,
      },
    ],
  });
  if (register) await rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  return {
    db,
    local,
    shared,
    executions,
    originals,
    inspect: () => inspectSharedRecoveryActionCheckpoint(db, key),
    require: (input: unknown = originals.payload) =>
      requireStoredSharedRecoveryActionCheckpoint(
        db,
        input,
        identity,
        executions.payload,
        shared.payload,
      ),
  };
}
it("registers original expectations idempotently without converting retained timestamps", async () => {
  const f = await fixture(false),
    binding = { checkpoint: f.originals.checkpoint, localCheckpoint: f.local.checkpoint };
  expect(await f.inspect()).toBeNull();
  expect(await rememberSharedRecoveryActionCheckpoint(f.db, f.originals.checkpoint)).toEqual({
    binding,
    changed: true,
  });
  await f.db.run(sql`UPDATE local_recovery_actions SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
  );
  expect(await rememberSharedRecoveryActionCheckpoint(f.db, f.originals.checkpoint)).toEqual({
    binding,
    changed: false,
  });
  expect(await f.inspect()).toEqual(binding);
  expect(await withReadTx(f.db, (tx) => readSharedRecoveryActionCheckpoint(tx, key))).toEqual(
    binding,
  );
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
    ),
  ).toEqual(before);
});
it.each(["executions", "shared", "local"])(
  "requires live %s sources even for an idempotent registration",
  async (source) => {
    const f = await fixture();
    await f.db.run(
      sql.raw(
        `DELETE FROM ${source === "executions" ? "local_recovery_executions" : source === "shared" ? "local_recovery_shared_history" : "local_recovery_checkpoint"}`,
      ),
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.originals.checkpoint);
    await expect(
      rememberSharedRecoveryActionCheckpoint(f.db, f.originals.checkpoint),
    ).rejects.toThrow();
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.require()).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["hash", "length", "selection", "execution", "local-binding"])(
  "refuses changed original %s under an existing key",
  async (change) => {
    const f = await fixture(),
      checkpoint = clone(f.originals.checkpoint);
    if (change === "hash") checkpoint.sha256 = "b".repeat(64);
    if (change === "length") checkpoint.byteLength++;
    if (change === "selection") checkpoint.selection.actionIds.push("another");
    if (change === "execution") {
      checkpoint.checkpoint.sha256 = "b".repeat(64);
      await f.db.run(
        sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(checkpoint.checkpoint)}`,
      );
    }
    if (change === "local-binding") {
      const local = JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) });
      await f.db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${local}`);
      await f.db.run(sql`UPDATE local_recovery_shared_history SET local_descriptor=${local}`);
      await f.db.run(sql`UPDATE local_recovery_executions SET local_descriptor=${local}`);
    }
    await expect(rememberSharedRecoveryActionCheckpoint(f.db, checkpoint)).rejects.toThrow(
      "different contents or bindings",
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.originals.checkpoint);
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps original %s keys independent",
  async (field) => {
    const f = await fixture(),
      other = { ...identity, [field]: "other" },
      local = { ...f.local.checkpoint, identity: other },
      shared = { ...f.shared.checkpoint, identity: other };
    await rememberLocalRecoveryCheckpoint(f.db, local);
    await rememberSharedRecoveryCheckpoint(f.db, shared);
    const executions = { ...f.executions.checkpoint, checkpoint: shared };
    await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
    const checkpoint = { ...f.originals.checkpoint, checkpoint: executions };
    await rememberSharedRecoveryActionCheckpoint(f.db, checkpoint);
    expect(await inspectSharedRecoveryActionCheckpoint(f.db, { ...key, [field]: "other" })).toEqual(
      { checkpoint, localCheckpoint: local },
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.originals.checkpoint);
  },
);
it("copies registration input before its write boundary", async () => {
  const f = await fixture(false),
    input = clone(f.originals.checkpoint),
    writing = rememberSharedRecoveryActionCheckpoint(f.db, input);
  input.sha256 = "b".repeat(64);
  input.selection.actionIds.length = 0;
  input.checkpoint.checkpoint.identity.deviceId = "changed";
  expect((await writing).binding.checkpoint).toEqual(f.originals.checkpoint);
});
it.each(["statement", "commit"])(
  "rolls back original registration and dependent writes after %s failure",
  async (failure) => {
    const f = await fixture(false);
    await f.db.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (failure === "commit") {
      await f.db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.db.run(
        sql`CREATE TRIGGER reject_originals AFTER INSERT ON local_recovery_actions BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_originals BEFORE INSERT ON local_recovery_actions BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(
      withTx(f.db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberSharedRecoveryActionCheckpointInTx(tx, f.originals.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.db.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.db.run(sql`DROP TRIGGER reject_originals`);
    await rememberSharedRecoveryActionCheckpoint(f.db, f.originals.checkpoint);
  },
);
it("resolves trusted original records before hashing received inputs or selections", async () => {
  const f = await fixture(false),
    digest = vi.spyOn(crypto.subtle, "digest");
  await expect(f.require()).rejects.toThrow("not registered");
  expect(digest).not.toHaveBeenCalled();
  await rememberSharedRecoveryActionCheckpoint(f.db, f.originals.checkpoint);
  expect(await f.require()).toEqual(f.originals.payload);
  const input = clone(f.originals.payload);
  input.actions[2].input.ref = "changed";
  await expect(f.require(input)).rejects.toThrow("content mismatch");
  input.actions.pop();
  input.selection.actionIds.pop();
  await expect(f.require(input)).rejects.toThrow("binding mismatch");
});
it.each([
  "removed-actions",
  "changed-actions",
  "removed-executions",
  "changed-executions",
  "removed-shared",
  "changed-shared",
  "removed-local",
  "changed-local",
  "changed-bound-local",
  "changed-execution-local",
  "changed-shared-local",
  "rebound-all",
])("rechecks all four bindings after %s during hashing", async (change) => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const tables = {
      actions: "local_recovery_actions",
      executions: "local_recovery_executions",
      shared: "local_recovery_shared_history",
      local: "local_recovery_checkpoint",
    };
    if (change.startsWith("removed-"))
      await f.db.run(sql.raw(`DELETE FROM ${tables[change.slice(8) as keyof typeof tables]}`));
    const checkpoints = {
      actions: f.originals.checkpoint,
      executions: f.executions.checkpoint,
      shared: f.shared.checkpoint,
      local: f.local.checkpoint,
    };
    if (change.startsWith("changed-") && change.slice(8) in checkpoints) {
      const source = change.slice(8) as keyof typeof tables;
      await f.db.run(
        sql`UPDATE ${sql.raw(tables[source])} SET descriptor=${JSON.stringify({ ...checkpoints[source], sha256: "b".repeat(64) })}`,
      );
    }
    if (change === "changed-bound-local")
      await f.db.run(
        sql`UPDATE local_recovery_actions SET local_descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "changed-execution-local")
      await f.db.run(
        sql`UPDATE local_recovery_executions SET local_descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "changed-shared-local")
      await f.db.run(
        sql`UPDATE local_recovery_shared_history SET local_descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "rebound-all") {
      const local = { ...f.local.checkpoint, sha256: "b".repeat(64) },
        shared = { ...f.shared.checkpoint, sha256: "c".repeat(64) },
        executions = { ...f.executions.checkpoint, checkpoint: shared, sha256: "d".repeat(64) };
      await withTx(f.db, async (tx) => {
        await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(local)}`);
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(shared)},local_descriptor=${JSON.stringify(local)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(executions)},local_descriptor=${JSON.stringify(local)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...f.originals.checkpoint, checkpoint: executions })},local_descriptor=${JSON.stringify(local)}`,
        );
      });
    }
    return digest(...args);
  });
  await expect(f.require()).rejects.toThrow();
});
it("allows unrelated registrations and equivalent descriptor formatting outside catalog reads", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const identity2 = { ...identity, checkpointId: "other" },
      local = { ...f.local.checkpoint, identity: identity2 },
      shared = { ...f.shared.checkpoint, identity: identity2 },
      executions = { ...f.executions.checkpoint, checkpoint: shared };
    await rememberLocalRecoveryCheckpoint(f.db, local);
    await rememberSharedRecoveryCheckpoint(f.db, shared);
    await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
    await rememberSharedRecoveryActionCheckpoint(f.db, {
      ...f.originals.checkpoint,
      checkpoint: executions,
    });
    await f.db.run(
      sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify(f.originals.checkpoint, null, 2)},local_descriptor=${JSON.stringify(f.local.checkpoint, null, 2)} WHERE checkpoint_id=${key.checkpointId}`,
    );
    return digest(...args);
  });
  expect(await f.require()).toEqual(f.originals.payload);
});
it("owns every input before the first catalog read yields", async () => {
  const f = await fixture(),
    input = clone(f.originals.payload),
    executions = clone(f.executions.payload),
    shared = clone(f.shared.payload),
    expected = { ...identity };
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw new Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, (tx) => {
        input.actions.length = 0;
        executions.effectSets.length = 0;
        shared.history.effectSets.length = 0;
        expected.deviceId = "changed";
        return work(tx as unknown as DatabaseHandle);
      }),
  });
  expect(
    await requireStoredSharedRecoveryActionCheckpoint(wrapped, input, expected, executions, shared),
  ).toEqual(f.originals.payload);
});
it("preserves exact original metadata through shared restoration and local validation", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE local_recovery_actions SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
  );
  expect(capturedTables.some(({ name }) => name === "local_recovery_actions")).toBe(false);
  const capture = await installCapturePrototype(f.db as unknown as SourceDB);
  await capture.restore(async () => (await database()) as unknown as SourceDB, []);
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
    ),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => selected,
  );
  expect(snapshot.tables).toHaveLength(14);
  expect(
    snapshot.tables.find(({ name }) => name === "local_recovery_actions")!.rows[0].created_at,
  ).toEqual(["integer", "9223372036854775807"]);
  const target = await database();
  await validateLocalRecoverySnapshot(async () => target, snapshot, snapshot.identity);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_actions`)).toEqual([]);
});
it.each(["hash", "local-selection", "nested-selection"])(
  "rejects malformed original %s metadata before validation SQL",
  async (change) => {
    const f = await fixture(),
      descriptor = clone(f.originals.checkpoint),
      local = clone(f.local.checkpoint);
    if (change === "hash") descriptor.sha256 = "bad";
    if (change === "local-selection") local.selection.effectSetIds = [];
    if (change === "nested-selection")
      descriptor.checkpoint.selection.effectSets[0].executionCount = 0;
    await f.db.run(
      sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify(descriptor)},local_descriptor=${JSON.stringify(local)}`,
    );
    await expect(f.inspect()).rejects.toThrow();
    const snapshot = await captureLocalRecoverySnapshot(
        f.db,
        { ...identity, checkpointId: "later" },
        async () => selected,
      ),
      create = vi.fn(database);
    await expect(
      validateLocalRecoverySnapshot(create, snapshot, snapshot.identity),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it("checks nested row identity, original local coherence and SQL descriptor constraints", async () => {
  const f = await fixture();
  expect(() =>
    parseSharedRecoveryActionCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(f.originals.checkpoint),
      JSON.stringify(f.local.checkpoint),
    ),
  ).toThrow("identity mismatch");
  expect(() =>
    parseSharedRecoveryActionCheckpointRecord(key, {}, JSON.stringify(f.local.checkpoint)),
  ).toThrow("TEXT");
  await f.db.run(sql`DELETE FROM local_recovery_actions`);
  for (const change of [
    "key",
    "version",
    "execution-version",
    "shared-version",
    "local-identity",
    "local-schema",
  ]) {
    const descriptor = clone(f.originals.checkpoint),
      local = clone(f.local.checkpoint);
    if (change === "version") descriptor.version = 2;
    if (change === "execution-version") descriptor.checkpoint.version = 2;
    if (change === "shared-version") descriptor.checkpoint.checkpoint.version = 2;
    if (change === "local-identity") local.identity.deviceId = "other";
    if (change === "local-schema") local.identity.schemaId = migrations.at(-2)!.id;
    await expect(
      f.db.insert(localRecoveryActionsTable).values({
        ...key,
        checkpointId: change === "key" ? "other" : key.checkpointId,
        descriptor: JSON.stringify(descriptor),
        localDescriptor: JSON.stringify(local),
        createdAt: new Date(0),
      }),
    ).rejects.toThrow();
  }
});
it("retains historical and orphaned original expectations without loading old-schema records", async () => {
  const f = await fixture(false),
    old = { ...identity, schemaId: migrations.at(-2)!.id };
  await f.db.run(sql`DELETE FROM local_recovery_executions`);
  await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
  await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
  const local = { ...f.local.checkpoint, identity: old },
    shared = { ...f.shared.checkpoint, identity: old },
    executions = { ...f.executions.checkpoint, checkpoint: shared };
  await rememberLocalRecoveryCheckpoint(f.db, local);
  await rememberSharedRecoveryCheckpoint(f.db, shared);
  await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
  const checkpoint = { ...f.originals.checkpoint, checkpoint: executions };
  await rememberSharedRecoveryActionCheckpoint(f.db, checkpoint);
  expect(await f.inspect()).toEqual({ checkpoint, localCheckpoint: local });
  await expect(
    requireStoredSharedRecoveryActionCheckpoint(
      f.db,
      f.originals.payload,
      old,
      f.executions.payload,
      f.shared.payload,
    ),
  ).rejects.toThrow("Unsupported");
  await f.db.run(sql`DELETE FROM local_recovery_executions`);
  await f.db.run(sql`DELETE FROM local_recovery_shared_history`);
  await f.db.run(sql`DELETE FROM local_recovery_checkpoint`);
  expect(await f.inspect()).toEqual({ checkpoint, localCheckpoint: local });
});
it.each([false, true])(
  "migration 31 preserves source catalogs and rolls back failed upgrades (rollback=%s)",
  async (fail) => {
    const f = await fixture(false),
      migration = migrations.find(({ id }) => id === "0031_local_recovery_actions")!;
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
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      { sql: "UPDATE local_recovery_executions SET created_at=9223372036854775807", args: [] },
    ]);
    const before = await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
    );
    if (fail) {
      await f.db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(f.db)).rejects.toThrow();
      await expect(f.db.values(sql`SELECT 1 FROM local_recovery_actions`)).rejects.toThrow();
      await f.db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.db)).appliedIds).toEqual(
      migrations.filter(({ idx }) => idx >= migration.idx).map(({ id }) => id),
    );
    expect(
      await f.db.values(
        sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_executions`,
      ),
    ).toEqual(before);
    await rememberSharedRecoveryActionCheckpoint(f.db, f.originals.checkpoint);
  },
);
