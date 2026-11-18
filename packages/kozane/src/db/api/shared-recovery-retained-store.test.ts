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
import { localRecoveryRetainedHistoryTable, namespaceTable } from "@kozane/core/schema";
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
  describeSharedRecoveryRetainedHistory,
  rememberSharedRecoveryRetainedCheckpoint,
  rememberSharedRecoveryRetainedCheckpointInTx,
  inspectSharedRecoveryRetainedCheckpoint,
  readSharedRecoveryRetainedCheckpoint,
  parseSharedRecoveryRetainedCheckpointRecord,
  requireStoredSharedRecoveryRetainedCheckpoint,
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
  await rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  const originHistory = await describeSharedRecoveryHistory(
    {
      baseline: { id: "before-origin", projection: shared.payload.history.baseline.projection },
      effectSets: [
        {
          id: "origin",
          effects: [
            {
              ord: 0,
              table: "namespace",
              key: { id: ["text", "deselected"] },
              op: "I",
              before: null,
              after: {
                id: ["text", "deselected"],
                name: ["text", "first"],
                is_default: ["integer", "0"],
              },
            },
            {
              ord: 1,
              table: "namespace",
              key: { id: ["text", "deselected"] },
              op: "D",
              after: null,
              before: {
                id: ["text", "deselected"],
                name: ["text", "first"],
                is_default: ["integer", "0"],
              },
            },
          ],
        },
      ],
    },
    identity,
    { baselineId: "before-origin", effectSets: [{ id: "origin", effectCount: 2 }] },
  );
  const originExecutions = await describeSharedRecoveryExecutions({
    checkpoint: originHistory.checkpoint,
    sharedHistory: originHistory.payload,
    selection: {
      baselineId: "before-origin",
      effectSets: [{ id: "origin", rootId: "root", executionCount: 2 }],
    },
    effectSets: [
      {
        ...executions.payload.effectSets[0],
        id: "origin",
        effects: [
          { ord: 0, actionId: "child", executionOrd: 1 },
          { ord: 1, actionId: "root", executionOrd: 0 },
        ],
      },
    ],
  });
  const retained = await describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: {
      effectSets: [
        {
          id: "origin",
          rootId: "root",
          source: "origin",
          baselineId: "before-origin",
          effectCount: 2,
          executionCount: 2,
        },
        {
          id: "empty",
          rootId: "root",
          source: "authoritative",
          baselineId: "baseline",
          effectCount: 0,
          executionCount: 2,
        },
      ],
    },
    effectSets: [
      {
        id: "origin",
        rootId: "root",
        source: "origin",
        history: originHistory.payload,
        executions: originExecutions.payload,
      },
      {
        id: "empty",
        rootId: "root",
        source: "authoritative",
        history: shared.payload,
        executions: executions.payload,
      },
    ],
  });
  if (register) await rememberSharedRecoveryRetainedCheckpoint(db, retained.checkpoint);
  return {
    db,
    local,
    shared,
    executions,
    originals,
    retained,
    inspect: () => inspectSharedRecoveryRetainedCheckpoint(db, key),
    require: (input: unknown = retained.payload) =>
      requireStoredSharedRecoveryRetainedCheckpoint(
        db,
        input,
        identity,
        originals.payload,
        executions.payload,
        shared.payload,
      ),
  };
}
it("registers retained inventory idempotently and reads exact metadata without timestamp conversion", async () => {
  const f = await fixture(false),
    binding = { checkpoint: f.retained.checkpoint, localCheckpoint: f.local.checkpoint };
  expect(await f.inspect()).toBeNull();
  expect(await rememberSharedRecoveryRetainedCheckpoint(f.db, f.retained.checkpoint)).toEqual({
    binding,
    changed: true,
  });
  await f.db.run(sql`UPDATE local_recovery_retained_history SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
  );
  expect(await rememberSharedRecoveryRetainedCheckpoint(f.db, f.retained.checkpoint)).toEqual({
    binding,
    changed: false,
  });
  expect(await f.inspect()).toEqual(binding);
  expect(await withReadTx(f.db, (tx) => readSharedRecoveryRetainedCheckpoint(tx, key))).toEqual(
    binding,
  );
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
    ),
  ).toEqual(before);
  expect(await f.require()).toEqual(f.retained.payload);
});
const tables = {
  retained: "local_recovery_retained_history",
  originals: "local_recovery_actions",
  executions: "local_recovery_executions",
  shared: "local_recovery_shared_history",
  local: "local_recovery_checkpoint",
} as const;
it.each(["originals", "executions", "shared", "local"] as const)(
  "requires live %s even for idempotent registration",
  async (source) => {
    const f = await fixture();
    await f.db.run(sql.raw(`DELETE FROM ${tables[source]}`));
    expect((await f.inspect())!.checkpoint).toEqual(f.retained.checkpoint);
    await expect(
      rememberSharedRecoveryRetainedCheckpoint(f.db, f.retained.checkpoint),
    ).rejects.toThrow();
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.require()).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["hash", "length", "source", "count", "originals", "local"])(
  "refuses replaced retained %s under an existing identity",
  async (change) => {
    const f = await fixture(),
      checkpoint = clone(f.retained.checkpoint);
    if (change === "hash") checkpoint.sha256 = "b".repeat(64);
    if (change === "length") checkpoint.byteLength++;
    if (change === "source") checkpoint.selection.effectSets[0].source = "rebase";
    if (change === "count") checkpoint.selection.effectSets[0].effectCount++;
    if (change === "originals") {
      checkpoint.checkpoint.sha256 = "b".repeat(64);
      await f.db.run(
        sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify(checkpoint.checkpoint)}`,
      );
    }
    if (change === "local") {
      const local = JSON.stringify({ ...f.local.checkpoint, sha256: "b".repeat(64) });
      for (const table of ["originals", "executions", "shared"] as const)
        await f.db.run(sql`UPDATE ${sql.raw(tables[table])} SET local_descriptor=${local}`);
      await f.db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${local}`);
    }
    await expect(rememberSharedRecoveryRetainedCheckpoint(f.db, checkpoint)).rejects.toThrow(
      "different contents or bindings",
    );
    expect((await f.inspect())!.checkpoint).toEqual(f.retained.checkpoint);
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
      checkpoint = { ...f.retained.checkpoint, checkpoint: originals };
    await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
    await rememberSharedRecoveryActionCheckpoint(f.db, originals);
    await rememberSharedRecoveryRetainedCheckpoint(f.db, checkpoint);
    expect(
      await inspectSharedRecoveryRetainedCheckpoint(f.db, { ...key, [field]: "other" }),
    ).toEqual({ checkpoint, localCheckpoint: local });
    expect((await f.inspect())!.checkpoint).toEqual(f.retained.checkpoint);
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
        sql`CREATE TRIGGER reject_retained AFTER INSERT ON local_recovery_retained_history BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await f.db.run(
        sql`CREATE TRIGGER reject_retained BEFORE INSERT ON local_recovery_retained_history BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(
      withTx(f.db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberSharedRecoveryRetainedCheckpointInTx(tx, f.retained.checkpoint);
      }),
    ).rejects.toThrow();
    expect(await f.inspect()).toBeNull();
    expect((await f.db.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Original");
    await f.db.run(sql`DROP TRIGGER reject_retained`);
    await rememberSharedRecoveryRetainedCheckpoint(f.db, f.retained.checkpoint);
  },
);
it("resolves trusted inventory before hashing and refuses truncated deselected history", async () => {
  const f = await fixture(false),
    digest = vi.spyOn(crypto.subtle, "digest");
  await expect(f.require()).rejects.toThrow("not registered");
  expect(digest).not.toHaveBeenCalled();
  await rememberSharedRecoveryRetainedCheckpoint(f.db, f.retained.checkpoint);
  const payload = clone(f.retained.payload);
  payload.selection.effectSets.shift();
  payload.effectSets.shift();
  await expect(f.require(payload)).rejects.toThrow("binding mismatch");
  expect(await f.require()).toEqual(f.retained.payload);
});
it.each(Object.keys(tables) as (keyof typeof tables)[])(
  "rechecks %s after removal or mutation while hashing",
  async (source) => {
    for (const remove of [false, true]) {
      const f = await fixture(),
        digest = crypto.subtle.digest.bind(crypto.subtle),
        checkpoints = {
          retained: f.retained.checkpoint,
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
it.each(["retained", "originals", "executions", "shared"] as const)(
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
      retained = { ...f.retained.checkpoint, checkpoint: originals };
    await withTx(f.db, async (tx) => {
      await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(local)}`);
      for (const [table, descriptor] of [
        [tables.shared, shared],
        [tables.executions, executions],
        [tables.originals, originals],
        [tables.retained, retained],
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
      sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify(f.retained.checkpoint, null, 2)},local_descriptor=${JSON.stringify(f.local.checkpoint, null, 2)}`,
    );
    return digest(...args);
  });
  expect(await f.require()).toEqual(f.retained.payload);
});
it("owns all transport inputs before the first catalog read yields", async () => {
  const f = await fixture(),
    payload = clone(f.retained.payload),
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
        originals.actions.length = 0;
        executions.effectSets.length = 0;
        shared.history.effectSets.length = 0;
        expected.deviceId = "changed";
        return work(tx as unknown as DatabaseHandle);
      }),
  });
  expect(
    await requireStoredSharedRecoveryRetainedCheckpoint(
      wrapped,
      payload,
      expected,
      originals,
      executions,
      shared,
    ),
  ).toEqual(f.retained.payload);
});
it("owns registration inputs before the write boundary", async () => {
  const f = await fixture(false),
    input = clone(f.retained.checkpoint),
    writing = rememberSharedRecoveryRetainedCheckpoint(f.db, input);
  input.sha256 = "b".repeat(64);
  input.selection.effectSets.length = 0;
  expect((await writing).binding.checkpoint).toEqual(f.retained.checkpoint);
});
it("preserves retained metadata through shared restoration and exact local SQL validation", async () => {
  const f = await fixture();
  await f.db.run(sql`UPDATE local_recovery_retained_history SET created_at=9223372036854775807`);
  const before = await f.db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
  );
  expect(capturedTables.some(({ name }) => name === tables.retained)).toBe(false);
  const capture = await installCapturePrototype(f.db as unknown as SourceDB);
  await capture.restore(async () => (await database()) as unknown as SourceDB, []);
  expect(
    await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_retained_history`,
    ),
  ).toEqual(before);
  const snapshot = await captureLocalRecoverySnapshot(
    f.db,
    { ...identity, checkpointId: "later" },
    async () => selected,
  );
  expect(snapshot.tables).toHaveLength(10);
  expect(snapshot.tables.find(({ name }) => name === tables.retained)!.rows[0].created_at).toEqual([
    "integer",
    "9223372036854775807",
  ]);
  const target = await database();
  await validateLocalRecoverySnapshot(async () => target, snapshot, snapshot.identity);
  expect(await target.values(sql`SELECT 1 FROM local_recovery_retained_history`)).toEqual([]);
});
it.each(["hash", "local-selection", "inventory"])(
  "rejects malformed retained %s metadata before SQL allocation",
  async (change) => {
    const f = await fixture(),
      descriptor = clone(f.retained.checkpoint),
      local = clone(f.local.checkpoint);
    if (change === "hash") descriptor.sha256 = "bad";
    if (change === "local-selection") local.selection.effectSetIds = [];
    if (change === "inventory") descriptor.selection.effectSets.pop();
    await f.db.run(
      sql`UPDATE local_recovery_retained_history SET descriptor=${JSON.stringify(descriptor)},local_descriptor=${JSON.stringify(local)}`,
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
  "original-version",
  "execution-version",
  "shared-version",
  "local-identity",
  "local-schema",
])("enforces %s SQL descriptor constraints", async (change) => {
  const f = await fixture(false),
    descriptor = clone(f.retained.checkpoint),
    local = clone(f.local.checkpoint);
  if (change === "version") descriptor.version = 2;
  if (change === "original-version") descriptor.checkpoint.version = 2;
  if (change === "execution-version") descriptor.checkpoint.checkpoint.version = 2;
  if (change === "shared-version") descriptor.checkpoint.checkpoint.checkpoint.version = 2;
  if (change === "local-identity") local.identity.deviceId = "other";
  if (change === "local-schema") local.identity.schemaId = migrations.at(-2)!.id;
  await expect(
    f.db.insert(localRecoveryRetainedHistoryTable).values({
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
    checkpoint = { ...f.retained.checkpoint, checkpoint: originals };
  for (const table of ["originals", "executions", "shared", "local"] as const)
    await f.db.run(sql.raw(`DELETE FROM ${tables[table]}`));
  await rememberLocalRecoveryCheckpoint(f.db, local);
  await rememberSharedRecoveryCheckpoint(f.db, shared);
  await rememberSharedRecoveryExecutionCheckpoint(f.db, executions);
  await rememberSharedRecoveryActionCheckpoint(f.db, originals);
  await rememberSharedRecoveryRetainedCheckpoint(f.db, checkpoint);
  for (const table of ["originals", "executions", "shared", "local"] as const)
    await f.db.run(sql.raw(`DELETE FROM ${tables[table]}`));
  expect(await f.inspect()).toEqual({ checkpoint, localCheckpoint: local });
  expect(() =>
    parseSharedRecoveryRetainedCheckpointRecord(
      { ...key, checkpointId: "other" },
      JSON.stringify(checkpoint),
      JSON.stringify(local),
    ),
  ).toThrow("identity mismatch");
  expect(() => parseSharedRecoveryRetainedCheckpointRecord(key, {}, JSON.stringify(local))).toThrow(
    "TEXT",
  );
  await expect(
    requireStoredSharedRecoveryRetainedCheckpoint(
      f.db,
      f.retained.payload,
      old,
      f.originals.payload,
      f.executions.payload,
      f.shared.payload,
    ),
  ).rejects.toThrow("Unsupported");
});
it.each([false, true])(
  "migration 32 preserves original catalogs and rolls back failed upgrades (rollback=%s)",
  async (fail) => {
    const f = await fixture(false),
      migration = migrations.at(-1)!;
    await withMigration(f.db, async () => [
      { sql: "DROP TABLE local_recovery_retained_history", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      { sql: "UPDATE local_recovery_actions SET created_at=9223372036854775807", args: [] },
    ]);
    const before = await f.db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
    );
    if (fail) {
      await f.db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(f.db)).rejects.toThrow();
      await expect(
        f.db.values(sql`SELECT 1 FROM local_recovery_retained_history`),
      ).rejects.toThrow();
      await f.db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(f.db)).appliedIds).toEqual([migration.id]);
    expect(
      await f.db.values(
        sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_actions`,
      ),
    ).toEqual(before);
    await rememberSharedRecoveryRetainedCheckpoint(f.db, f.retained.checkpoint);
  },
);
