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
import { localRecoveryRunArchivesTable, namespaceTable } from "@kozane/core/schema";
import {
  captureLocalRecoverySnapshot,
  validateLocalRecoverySnapshot,
  rememberLocalRecoveryCheckpoint,
  rememberSharedRecoveryCheckpoint,
  rememberSharedRecoveryExecutionCheckpoint,
  rememberSharedRecoveryActionCheckpoint,
  rememberSharedRecoveryActionArchiveCheckpoint,
  describeSharedRecoveryRunArchive,
  rememberSharedRecoveryRunArchiveCheckpoint,
  rememberSharedRecoveryRunArchiveCheckpointInTx,
  inspectSharedRecoveryRunArchiveCheckpoint,
  readSharedRecoveryRunArchiveCheckpoint,
  parseSharedRecoveryRunArchiveCheckpointRecord,
  requireStoredSharedRecoveryRunArchiveCheckpoint,
} from "@kozane/core/recovery";
import { sharedRecoveryRunArchiveFixture } from "../../test-utils/shared-recovery-run-archive.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";
import { createTestDB } from "../../test-utils/db.js";
import type { DB as SourceDB } from "../../../../core/src/database.js";
import { capturedTables, installCapturePrototype } from "../../test-utils/action-capture.js";
const database = async () => (await createTestDB()) as unknown as DB;
const { schemaId: _schemaId, ...key } = identity;
const selected = { baselineId: "baseline", effectSetIds: ["rebase", "noop"] };
const clone = (input: unknown) => JSON.parse(JSON.stringify(input));
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(register = true) {
  const source = await sharedRecoveryRunArchiveFixture(),
    db = await database(),
    local = { checkpoint: source.localCheckpoint },
    shared = {
      payload: source.sharedHistory,
      checkpoint: source.checkpoint.checkpoint.checkpoint.checkpoint,
    },
    executions = {
      payload: source.executions,
      checkpoint: source.checkpoint.checkpoint.checkpoint,
    },
    originals = { payload: source.originals, checkpoint: source.checkpoint.checkpoint },
    actionArchive = { payload: source.actionArchive, checkpoint: source.checkpoint };
  await rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  await rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  await rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  await rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  await rememberSharedRecoveryActionArchiveCheckpoint(db, actionArchive.checkpoint);
  const archive = await describeSharedRecoveryRunArchive(source);
  if (register) await rememberSharedRecoveryRunArchiveCheckpoint(db, archive.checkpoint);
  return {
    db,
    local,
    shared,
    executions,
    originals,
    actionArchive,
    archive,
    inspect: () => inspectSharedRecoveryRunArchiveCheckpoint(db, key),
    require: (input: unknown = archive.payload) =>
      requireStoredSharedRecoveryRunArchiveCheckpoint(db, input, identity, {
        actionArchive: actionArchive.payload,
        originals: originals.payload,
        executions: executions.payload,
        sharedHistory: shared.payload,
      }),
  };
}
it("registers archive inventory idempotently and reads exact metadata without timestamp conversion", async () => {
  const f = await fixture(false),
    binding = { checkpoint: f.archive.checkpoint, localCheckpoint: f.local.checkpoint };
  expect(await f.inspect()).toBeNull();
  expect(await rememberSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.checkpoint)).toEqual({
    binding,
    changed: true,
  });
  await f.db.run(sql`UPDATE local_recovery_run_archives SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_run_archives`,
  );
  expect(await rememberSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.checkpoint)).toEqual({
    binding,
    changed: false,
  });
  expect(await f.inspect()).toEqual(binding);
  expect(await withReadTx(f.db, (tx) => readSharedRecoveryRunArchiveCheckpoint(tx, key))).toEqual(
    binding,
  );
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_run_archives`,
    ),
  ).toEqual(before);
  expect(await f.require()).toEqual(f.archive.payload);
});
const tables = {
  archive: "local_recovery_run_archives",
  actionArchive: "local_recovery_action_archives",
  originals: "local_recovery_actions",
  executions: "local_recovery_executions",
  shared: "local_recovery_shared_history",
  local: "local_recovery_checkpoint",
} as const;
it.each(["actionArchive", "originals", "executions", "shared", "local"] as const)(
  "requires live %s even for idempotent registration",
  async (source) => {
    const f = await fixture();
    await f.db.run(sql.raw(`DELETE FROM ${tables[source]}`));
    expect((await f.inspect())!.checkpoint).toEqual(f.archive.checkpoint);
    await expect(
      rememberSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.checkpoint),
    ).rejects.toThrow();
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.require()).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["hash", "length", "source", "count", "parent-archive", "local"])(
  "refuses replaced archive %s under an existing identity",
  async (change) => {
    const f = await fixture(),
      checkpoint = clone(f.archive.checkpoint);
    if (change === "hash") checkpoint.sha256 = "b".repeat(64);
    if (change === "length") checkpoint.byteLength++;
    if (change === "source") checkpoint.selection.effectSets[0].source = "authoritative";
    if (change === "count") checkpoint.selection.effectSets[0].effectCount++;
    if (change === "parent-archive") {
      checkpoint.checkpoint.sha256 = "b".repeat(64);
      await f.db.run(
        sql`UPDATE local_recovery_action_archives SET descriptor=${JSON.stringify(checkpoint.checkpoint)}`,
      );
    }
    if (change === "local") {
      const local = JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) });
      for (const table of ["actionArchive", "originals", "executions", "shared"] as const)
        await f.db.run(sql`UPDATE ${sql.raw(tables[table])} SET local_descriptor=${local}`);
      await f.db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${local}`);
    }
    await expect(rememberSharedRecoveryRunArchiveCheckpoint(f.db, checkpoint)).rejects.toThrow(
      "different contents or bindings",
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.archive.checkpoint);
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps %s keys independent",
  async (field) => {
    const f = await fixture(),
      other = { ...identity, [field]: "other" },
      local = { ...f.local.checkpoint, identity: other },
      shared = { ...f.shared.checkpoint, identity: other };
    await rememberLocalRecoveryCheckpoint(f.db, local);
    await rememberSharedRecoveryCheckpoint(f.db, shared);
    const executions = { ...f.executions.checkpoint, checkpoint: shared },
      originals = { ...f.originals.checkpoint, checkpoint: executions },
      actionArchive = { ...f.actionArchive.checkpoint, checkpoint: originals },
      checkpoint = { ...f.archive.checkpoint, checkpoint: actionArchive };
    await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
    await rememberSharedRecoveryActionCheckpoint(f.db, originals);
    await rememberSharedRecoveryActionArchiveCheckpoint(f.db, actionArchive);
    await rememberSharedRecoveryRunArchiveCheckpoint(f.db, checkpoint);
    expect(
      await inspectSharedRecoveryRunArchiveCheckpoint(f.db, { ...key, [field]: "other" }),
    ).toEqual({ checkpoint, localCheckpoint: local });
    expect((await f.inspect())!.checkpoint).toEqual(f.archive.checkpoint);
  },
);
it.each(["statement", "commit"])(
  "rolls back registration and dependent rows after %s failure",
  async (failure) => {
    const f = await fixture(false);
    await f.db.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (failure === "commit") {
      await f.db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await f.db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await f.db.run(
        sql`CREATE TRIGGER reject_archive AFTER INSERT ON local_recovery_run_archives BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_archive BEFORE INSERT ON local_recovery_run_archives BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(
      withTx(f.db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberSharedRecoveryRunArchiveCheckpointInTx(tx, f.archive.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.db.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.db.run(sql`DROP TRIGGER reject_archive`);
    await rememberSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.checkpoint);
  },
);
it("resolves trusted inventory before hashing and refuses truncated additional roots", async () => {
  const f = await fixture(false),
    digest = vi.spyOn(crypto.subtle, "digest");
  await expect(f.require()).rejects.toThrow("not registered");
  expect(digest).not.toHaveBeenCalled();
  await rememberSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.checkpoint);
  const payload = clone(f.archive.payload);
  payload.effectSets = payload.effectSets.filter((set: any) => set.rootId !== "detached");
  payload.selection.effectSets = payload.selection.effectSets.filter(
    (set: any) => set.rootId !== "detached",
  );
  await expect(f.require(payload)).rejects.toThrow("binding mismatch");
  expect(await f.require()).toEqual(f.archive.payload);
});
it.each(Object.keys(tables) as (keyof typeof tables)[])(
  "rechecks %s after removal or mutation while hashing",
  async (source) => {
    for (const remove of [false, true]) {
      const f = await fixture(),
        digest = crypto.subtle.digest.bind(crypto.subtle),
        checkpoints = {
          archive: f.archive.checkpoint,
          actionArchive: f.actionArchive.checkpoint,
          originals: f.originals.checkpoint,
          executions: f.executions.checkpoint,
          shared: f.shared.checkpoint,
          local: f.local.checkpoint,
        };
      vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
        await f.db.run(
          remove
            ? sql.raw(`DELETE FROM ${tables[source]}`)
            : sql`UPDATE ${sql.raw(tables[source])} SET descriptor=${JSON.stringify({ ...checkpoints[source], sha256: "b".repeat(64) })}`,
        );
        return digest(...args);
      });
      await expect(f.require()).rejects.toThrow();
      vi.restoreAllMocks();
    }
  },
);
it.each(["archive", "actionArchive", "originals", "executions", "shared"] as const)(
  "rechecks the exact %s local binding after hashing",
  async (source) => {
    const f = await fixture(),
      digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      await f.db.run(
        sql`UPDATE ${sql.raw(tables[source])} SET local_descriptor=${JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) })}`,
      );
      return digest(...args);
    });
    await expect(f.require()).rejects.toThrow();
  },
);
it("refuses coherent replacement of all original bindings during hashing", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const local = { ...f.local.checkpoint, sha256: "b".repeat(64) },
      shared = { ...f.shared.checkpoint, sha256: "c".repeat(64) },
      executions = { ...f.executions.checkpoint, checkpoint: shared },
      originals = { ...f.originals.checkpoint, checkpoint: executions },
      actionArchive = { ...f.actionArchive.checkpoint, checkpoint: originals },
      archive = { ...f.archive.checkpoint, checkpoint: actionArchive };
    await withTx(f.db, async (tx) => {
      await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(local)}`);
      for (const [table, descriptor] of [
        [tables.shared, shared],
        [tables.executions, executions],
        [tables.originals, originals],
        [tables.actionArchive, actionArchive],
        [tables.archive, archive],
      ] as const)
        await tx.run(
          sql`UPDATE ${sql.raw(table)} SET descriptor=${JSON.stringify(descriptor)},local_descriptor=${JSON.stringify(local)}`,
        );
    });
    return digest(...args);
  });
  await expect(f.require()).rejects.toThrow("changed during verification");
});
it("permits equivalent descriptor formatting outside the catalog read boundary", async () => {
  const f = await fixture(),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    await f.db.run(
      sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify(f.archive.checkpoint, null, 2)},local_descriptor=${JSON.stringify(f.local.checkpoint, null, 2)}`,
    );
    return digest(...args);
  });
  expect(await f.require()).toEqual(f.archive.payload);
});
it("owns all transport inputs before the first catalog read yields", async () => {
  const f = await fixture(),
    payload = clone(f.archive.payload),
    actionArchive = clone(f.actionArchive.payload),
    originals = clone(f.originals.payload),
    executions = clone(f.executions.payload),
    shared = clone(f.shared.payload),
    expected = { ...identity };
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, (tx) => {
        payload.effectSets.length = 0;
        actionArchive.actions.length = 0;
        originals.actions.length = 0;
        executions.effectSets.length = 0;
        shared.history.effectSets.length = 0;
        expected.deviceId = "changed";
        return work(tx as unknown as DatabaseHandle);
      }),
  });
  expect(
    await requireStoredSharedRecoveryRunArchiveCheckpoint(wrapped, payload, expected, {
      actionArchive,
      originals,
      executions,
      sharedHistory: shared,
    }),
  ).toEqual(f.archive.payload);
});
it("owns registration inputs before the write boundary", async () => {
  const f = await fixture(false),
    input = clone(f.archive.checkpoint),
    writing = rememberSharedRecoveryRunArchiveCheckpoint(f.db, input);
  input.sha256 = "b".repeat(64);
  input.selection.effectSets.length = 0;
  expect((await writing).binding.checkpoint).toEqual(f.archive.checkpoint);
});
it("preserves archive metadata through shared restoration and exact local SQL validation", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE local_recovery_run_archives SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_run_archives`,
  );
  expect(capturedTables.some(({ name }) => name === tables.archive)).toBe(false);
  const capture = await installCapturePrototype(f.db as unknown as SourceDB);
  await capture.restore(async () => (await database()) as unknown as SourceDB, []);
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_run_archives`,
    ),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => selected,
  );
  expect(snapshot.tables).toHaveLength(14);
  expect(snapshot.tables.find(({ name }) => name === tables.archive)!.rows[0].created_at).toEqual([
    "integer",
    "9223372036854775807",
  ]);
  const target = await database();
  await validateLocalRecoverySnapshot(async () => target, snapshot, snapshot.identity);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_run_archives`)).toEqual([]);
});
it.each(["hash", "local-selection", "inventory"])(
  "rejects malformed archive %s metadata before SQL allocation",
  async (change) => {
    const f = await fixture(),
      descriptor = clone(f.archive.checkpoint),
      local = clone(f.local.checkpoint);
    if (change === "hash") descriptor.sha256 = "bad";
    if (change === "local-selection") local.selection.effectSetIds = [];
    if (change === "inventory") descriptor.selection.effectSets.pop();
    await f.db.run(
      sql`UPDATE local_recovery_run_archives SET descriptor=${JSON.stringify(descriptor)},local_descriptor=${JSON.stringify(local)}`,
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
it.each([
  "key",
  "version",
  "archive-version",
  "original-version",
  "execution-version",
  "shared-version",
  "local-identity",
  "local-schema",
])("enforces %s SQL descriptor constraints", async (change) => {
  const f = await fixture(false),
    descriptor = clone(f.archive.checkpoint),
    local = clone(f.local.checkpoint);
  if (change === "version") descriptor.version = 2;
  if (change === "original-version") descriptor.checkpoint.checkpoint.version = 2;
  if (change === "archive-version") descriptor.checkpoint.version = 2;
  if (change === "execution-version") descriptor.checkpoint.checkpoint.checkpoint.version = 2;
  if (change === "shared-version")
    descriptor.checkpoint.checkpoint.checkpoint.checkpoint.version = 2;
  if (change === "local-identity") local.identity.deviceId = "other";
  if (change === "local-schema") local.identity.schemaId = migrations.at(-2)!.id;
  await expect(
    f.db.insert(localRecoveryRunArchivesTable).values({
      ...key,
      checkpointId: change === "key" ? "other" : key.checkpointId,
      descriptor: JSON.stringify(descriptor),
      localDescriptor: JSON.stringify(local),
      createdAt: new Date(0),
    }),
  ).rejects.toThrow();
});
it("parses coherent historical and orphaned expectations as metadata", async () => {
  const f = await fixture(false),
    old = { ...identity, schemaId: migrations.at(-2)!.id },
    local = { ...f.local.checkpoint, identity: old },
    shared = { ...f.shared.checkpoint, identity: old },
    executions = { ...f.executions.checkpoint, checkpoint: shared },
    originals = { ...f.originals.checkpoint, checkpoint: executions },
    actionArchive = { ...f.actionArchive.checkpoint, checkpoint: originals },
    checkpoint = { ...f.archive.checkpoint, checkpoint: actionArchive };
  for (const table of ["actionArchive", "originals", "executions", "shared", "local"] as const)
    await f.db.run(sql.raw(`DELETE FROM ${tables[table]}`));
  await rememberLocalRecoveryCheckpoint(f.db, local);
  await rememberSharedRecoveryCheckpoint(f.db, shared);
  await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
  await rememberSharedRecoveryActionCheckpoint(f.db, originals);
  await rememberSharedRecoveryActionArchiveCheckpoint(f.db, actionArchive);
  await rememberSharedRecoveryRunArchiveCheckpoint(f.db, checkpoint);
  for (const table of ["actionArchive", "originals", "executions", "shared", "local"] as const)
    await f.db.run(sql.raw(`DELETE FROM ${tables[table]}`));
  expect(await f.inspect()).toEqual({ checkpoint, localCheckpoint: local });
  expect(() =>
    parseSharedRecoveryRunArchiveCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(checkpoint),
      JSON.stringify(local),
    ),
  ).toThrow("identity mismatch");
  expect(() =>
    parseSharedRecoveryRunArchiveCheckpointRecord(key, {}, JSON.stringify(local)),
  ).toThrow("TEXT");
  await expect(
    requireStoredSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.payload, old, {
      actionArchive: f.actionArchive.payload,
      originals: f.originals.payload,
      executions: f.executions.payload,
      sharedHistory: f.shared.payload,
    }),
  ).rejects.toThrow("Unsupported");
});
it.each([false, true])(
  "migration 35 preserves original catalogs and rolls back failed upgrades (rollback=%s)",
  async (fail) => {
    const f = await fixture(false),
      migration = migrations.find((m) => m.id === "0035_local_recovery_run_archives")!;
    await withMigration(f.db, async () => [
      { sql: "DROP TABLE shared_recovery_installation", args: [] },
      { sql: "DROP TABLE local_recovery_installation", args: [] },
      { sql: "DROP TABLE local_recovery_run_assets", args: [] },
      { sql: "DROP TABLE local_recovery_run_archives", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      { sql: "UPDATE local_recovery_action_archives SET created_at=9223372036854775807", args: [] },
    ]);
    const before = await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_action_archives`,
    );
    if (fail) {
      await f.db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(f.db)).rejects.toThrow();
      await expect(f.db.values(sql`SELECT 1 FROM local_recovery_run_archives`)).rejects.toThrow();
      await f.db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.db)).appliedIds).toEqual(
      migrations.filter((m) => m.idx >= migration.idx).map((m) => m.id),
    );
    expect(
      await f.db.values(
        sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_action_archives`,
      ),
    ).toEqual(before);
    await rememberSharedRecoveryRunArchiveCheckpoint(f.db, f.archive.checkpoint);
  },
);
