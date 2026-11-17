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
import { namespaceTable, localRecoverySharedHistoryTable } from "../../../../core/src/schema.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
import { captureLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-checkpoint.js";
import { rememberLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-store.js";
import { validateLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-validation.js";
import { parseSharedRecoveryProjection } from "../../../../core/src/actions/shared-recovery.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import {
  inspectSharedRecoveryCheckpoint,
  rememberSharedRecoveryCheckpoint,
  rememberSharedRecoveryCheckpointInTx,
  validateStoredSharedRecoveryCheckpoint,
  parseSharedRecoveryCheckpointRecord,
} from "../../../../core/src/actions/shared-recovery-store.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const database = async () => (await createTestDB()) as unknown as DB;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const selection = { baselineId: "baseline", effectSetIds: ["a", "b"] };
async function fixture(register = true) {
  const source = await database();
  const local = await captureLocalRecoveryCheckpoint(source, identity, async () => selection);
  await rememberLocalRecoveryCheckpoint(source, local.checkpoint);
  const projection = parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: capturedTables.map(({ name }) => ({ name, rows: [] })),
  });
  const shared = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection },
      effectSets: [
        { id: "a", effects: [] },
        { id: "b", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "a", effectCount: 0 },
        { id: "b", effectCount: 0 },
      ],
    },
  );
  if (register) await rememberSharedRecoveryCheckpoint(source, shared.checkpoint);
  const inspect = () => inspectSharedRecoveryCheckpoint(source, key);
  const validate = (create = database, input: unknown = shared.payload) =>
    validateStoredSharedRecoveryCheckpoint(source, create, input, identity);
  return { source, local, shared, inspect, validate };
}

it("stores an immutable pair of shared and local expectations with idempotent registration", async () => {
  const f = await fixture(false);
  expect(await f.inspect()).toBeNull();
  const first = await rememberSharedRecoveryCheckpoint(f.source, f.shared.checkpoint);
  expect(first).toEqual({
    binding: { checkpoint: f.shared.checkpoint, localCheckpoint: f.local.checkpoint },
    changed: true,
  });
  await f.source.run(sql`UPDATE local_recovery_shared_history SET created_at=9223372036854775807`);
  const before = await f.source.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
  );
  expect(await rememberSharedRecoveryCheckpoint(f.source, f.shared.checkpoint)).toEqual({
    ...first,
    changed: false,
  });
  expect(await f.inspect()).toEqual(first.binding);
  expect(
    await f.source.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
    ),
  ).toEqual(before);
});

it("requires a registered local snapshot with matching identity and selected IDs", async () => {
  const f = await fixture(false);
  await f.source.run(sql`DELETE FROM local_recovery_checkpoint`);
  await expect(rememberSharedRecoveryCheckpoint(f.source, f.shared.checkpoint)).rejects.toThrow(
    "not registered",
  );
  for (const change of [
    { identity: { ...identity, schemaId: migrations.at(-2)!.id } },
    { selection: { ...selection, baselineId: "other" } },
    { selection: { ...selection, effectSetIds: ["b", "a"] } },
  ]) {
    await f.source.run(sql`DELETE FROM local_recovery_checkpoint`);
    await rememberLocalRecoveryCheckpoint(f.source, { ...f.local.checkpoint, ...change });
    await expect(rememberSharedRecoveryCheckpoint(f.source, f.shared.checkpoint)).rejects.toThrow(
      "does not match",
    );
  }
  expect(await f.inspect()).toBeNull();
});

it("copies registration inputs before opening its write transaction", async () => {
  const f = await fixture(false);
  const input = JSON.parse(JSON.stringify(f.shared.checkpoint));
  const registering = rememberSharedRecoveryCheckpoint(f.source, input);
  input.identity.deviceId = "changed";
  input.selection.effectSets.reverse();
  input.sha256 = "b".repeat(64);
  expect((await registering).binding.checkpoint).toEqual(f.shared.checkpoint);
});

it.each(["hash", "length", "counts", "local-binding"])(
  "refuses changed %s under an existing checkpoint key",
  async (change) => {
    const f = await fixture();
    const changed = JSON.parse(JSON.stringify(f.shared.checkpoint));
    if (change === "hash") changed.sha256 = "b".repeat(64);
    if (change === "length") changed.byteLength++;
    if (change === "counts") changed.selection.effectSets[0].effectCount++;
    if (change === "local-binding")
      await f.source.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    await expect(rememberSharedRecoveryCheckpoint(f.source, changed)).rejects.toThrow(
      "different contents or local binding",
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.shared.checkpoint);
  },
);

it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps independent %s keys separate",
  async (field) => {
    const f = await fixture();
    const other = { ...identity, [field]: "other" };
    await rememberLocalRecoveryCheckpoint(f.source, { ...f.local.checkpoint, identity: other });
    await rememberSharedRecoveryCheckpoint(f.source, { ...f.shared.checkpoint, identity: other });
    expect(
      (await inspectSharedRecoveryCheckpoint(f.source, { ...key, [field]: "other" }))!.checkpoint
        .identity,
    ).toEqual(other);
    expect((await f.inspect())!.checkpoint.identity).toEqual(identity);
  },
);

it.each([false, true])(
  "rolls back shared registration and dependent changes together (commit=%s)",
  async (commit) => {
    const f = await fixture(false);
    await f.source.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (commit) {
      await f.source.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.source.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.source.run(
        sql`CREATE TRIGGER reject_binding AFTER INSERT ON local_recovery_shared_history BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.source.run(
        sql`CREATE TRIGGER reject_binding BEFORE INSERT ON local_recovery_shared_history BEGIN SELECT RAISE(ABORT,'binding refused'); END`,
      );
    await expect(
      withTx(f.source, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberSharedRecoveryCheckpointInTx(tx, f.shared.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.source.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.source.run(sql`DROP TRIGGER reject_binding`);
    await rememberSharedRecoveryCheckpoint(f.source, f.shared.checkpoint);
  },
);

it("preserves exact local binding records across shared restoration and later local snapshots", async () => {
  const f = await fixture();
  await f.source.run(sql`UPDATE local_recovery_shared_history SET created_at=9223372036854775807`);
  const before = await f.source.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
  );
  const capture = await installCapturePrototype(f.source);
  expect(capturedTables).toHaveLength(12);
  expect(capturedTables.some(({ name }) => name === "local_recovery_shared_history")).toBe(false);
  await capture.restore(database, []);
  expect(
    await f.source.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
    ),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.source,
    { ...identity, checkpointId: "later" },
    async () => selection,
  );
  expect(snapshot.tables).toHaveLength(7);
  expect(
    snapshot.tables.find(({ name }) => name === "local_recovery_shared_history")!.rows[0]
      .created_at,
  ).toEqual(["integer", "9223372036854775807"]);
  await validateLocalRecoverySnapshot(database, snapshot, snapshot.identity);
});

it("preserves historical descriptor pairs as metadata without loading old-schema history", async () => {
  const f = await fixture(false);
  await f.source.run(sql`DELETE FROM local_recovery_checkpoint`);
  const oldIdentity = { ...identity, schemaId: migrations.at(-2)!.id };
  const local = { ...f.local.checkpoint, identity: oldIdentity };
  const shared = { ...f.shared.checkpoint, identity: oldIdentity };
  await rememberLocalRecoveryCheckpoint(f.source, local);
  await rememberSharedRecoveryCheckpoint(f.source, shared);
  expect(await f.inspect()).toEqual({ checkpoint: shared, localCheckpoint: local });
  const create = vi.fn(database);
  await expect(
    validateStoredSharedRecoveryCheckpoint(f.source, create, f.shared.payload, oldIdentity),
  ).rejects.toThrow("Unsupported");
  expect(create).not.toHaveBeenCalled();
});

it("checks descriptor row identity, local binding coherence and SQL constraints", async () => {
  const f = await fixture();
  expect(() =>
    parseSharedRecoveryCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(f.shared.checkpoint),
      JSON.stringify(f.local.checkpoint),
    ),
  ).toThrow("identity mismatch");
  expect(() =>
    parseSharedRecoveryCheckpointRecord(
      key,
      JSON.stringify({
        ...f.shared.checkpoint,
        selection: { ...f.shared.checkpoint.selection, baselineId: "other" },
      }),
      JSON.stringify(f.local.checkpoint),
    ),
  ).toThrow("does not match");
  await expect(
    f.source.insert(localRecoverySharedHistoryTable).values({
      ...key,
      checkpointId: "other",
      descriptor: JSON.stringify(f.shared.checkpoint),
      localDescriptor: JSON.stringify(f.local.checkpoint),
      createdAt: new Date(0),
    }),
  ).rejects.toThrow();
});

it("rejects malformed nested descriptors before local validation allocates a database", async () => {
  const f = await fixture();
  await f.source.run(
    sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify({ ...f.shared.checkpoint, sha256: "bad" })}`,
  );
  await expect(f.inspect()).rejects.toThrow();
  const snapshot = await captureLocalRecoverySnapshot(
    f.source,
    { ...identity, checkpointId: "later" },
    async () => selection,
  );
  const create = vi.fn(database);
  await expect(
    validateLocalRecoverySnapshot(create, snapshot, snapshot.identity),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("validates against the trusted descriptor pair without retaining temporary target rows", async () => {
  const f = await fixture();
  const target = await database();
  expect(await f.validate(async () => target)).toEqual({
    payload: f.shared.payload,
    projection: f.shared.projection,
  });
  expect(await target.values(sql`SELECT 1 FROM local_recovery_shared_history`)).toEqual([]);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_checkpoint`)).toEqual([]);
});

it.each(["missing-shared", "missing-local", "changed-local", "forged-payload"])(
  "refuses %s before allocating validation SQL",
  async (change) => {
    const f = await fixture();
    const payload = JSON.parse(JSON.stringify(f.shared.payload));
    if (change === "missing-shared")
      await f.source.run(sql`DELETE FROM local_recovery_shared_history`);
    if (change === "missing-local") await f.source.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "changed-local")
      await f.source.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "forged-payload")
      payload.history.baseline.projection.tables
        .find((table: { name: string }) => table.name === "namespace")
        .rows.push({
          id: ["text", "forged"],
          name: ["text", "Forged"],
          is_default: ["integer", "0"],
        });
    const create = vi.fn(database);
    await expect(f.validate(create, payload)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each([
  "removed-shared",
  "replaced-shared",
  "removed-local",
  "replaced-local",
  "replaced-bound-local",
])("refuses %s during isolated SQL validation", async (change) => {
  const f = await fixture();
  const target = await database();
  const create = vi.fn(async () => {
    if (change === "removed-shared")
      await f.source.run(sql`DELETE FROM local_recovery_shared_history`);
    if (change === "replaced-shared")
      await f.source.run(
        sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify({ ...f.shared.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "removed-local") await f.source.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "replaced-local")
      await f.source.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "replaced-bound-local")
      await f.source.run(
        sql`UPDATE local_recovery_shared_history SET local_descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    return target;
  });
  await expect(f.validate(create)).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(1);
  expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});

it("allows unrelated registrations and equivalent JSON formatting outside the catalog read boundary", async () => {
  const f = await fixture();
  await f.validate(async () => {
    const other = { ...identity, checkpointId: "other" };
    await rememberLocalRecoveryCheckpoint(f.source, { ...f.local.checkpoint, identity: other });
    await rememberSharedRecoveryCheckpoint(f.source, { ...f.shared.checkpoint, identity: other });
    await f.source.run(
      sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(f.shared.checkpoint, null, 2)},local_descriptor=${JSON.stringify(f.local.checkpoint, null, 2)} WHERE checkpoint_id=${key.checkpointId}`,
    );
    return database();
  });
});

it("owns payload and expected identity before the first catalog read yields", async () => {
  const f = await fixture();
  const payload = JSON.parse(JSON.stringify(f.shared.payload));
  const expected = { ...identity };
  const wrapped = createDatabaseAdapter(new Proxy(f.source, {}), {
    write: async () => {
      throw new Error("Unexpected source write");
    },
    read: (operation) =>
      withReadTx(f.source, (tx) => {
        payload.history.effectSets.length = 0;
        expected.deviceId = "changed";
        return operation(tx as unknown as DatabaseHandle);
      }),
  });
  expect(
    (await validateStoredSharedRecoveryCheckpoint(wrapped, database, payload, expected)).payload,
  ).toEqual(f.shared.payload);
});

it.each([false, true])(
  "migration 28 preserves local expectations and rolls back on failure (rollback=%s)",
  async (fail) => {
    const f = await fixture(false);
    const migration = migrations.find(({ tag }) => tag === "0028_local_recovery_shared_history")!;
    await withMigration(f.source, async () => [
      { sql: "DROP TABLE local_recovery_assets", args: [] },
      { sql: "DROP TABLE local_recovery_shared_history", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      { sql: "UPDATE local_recovery_checkpoint SET created_at=9223372036854775807", args: [] },
    ]);
    const before = await f.source.values(
      sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
    );
    if (fail) {
      await f.source.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(f.source)).rejects.toThrow();
      await expect(
        f.source.values(sql`SELECT 1 FROM local_recovery_shared_history`),
      ).rejects.toThrow();
      await f.source.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.source)).appliedIds).toEqual(
      migrations.slice(migration.idx).map(({ id }) => id),
    );
    expect(
      await f.source.values(
        sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
      ),
    ).toEqual(before);
    await rememberSharedRecoveryCheckpoint(f.source, f.shared.checkpoint);
  },
);
