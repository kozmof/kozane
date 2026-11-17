import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { withTx, withMigration, type DB } from "../../../../core/src/database.js";
import {
  localRecoveryCheckpointTable,
  localAssetManifestTable,
  namespaceTable,
} from "../../../../core/src/schema.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { applyMigrations } from "../../../../core/src/migrations/apply.js";
import { captureLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery.js";
import {
  captureLocalRecoveryCheckpoint,
  requireLocalRecoveryCheckpoint,
} from "../../../../core/src/actions/local-recovery-checkpoint.js";
import {
  rememberLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpointInTx,
  inspectLocalRecoveryCheckpoint,
} from "../../../../core/src/actions/local-recovery-store.js";
import { validateLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-validation.js";
import { installCapturePrototype, capturedTables } from "../../test-utils/action-capture.js";
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
const selection = { baselineId: "baseline", effectSetIds: ["a", "b"] };
const checkpoint = {
  version: 1,
  identity: { ...key, schemaId: migrations.at(-1)!.id },
  selection,
  byteLength: 642,
  sha256: "a".repeat(64),
};

it("reopens trusted descriptor metadata and preserves the original registration on idempotent calls", async () => {
  const db = await database();
  expect(await inspectLocalRecoveryCheckpoint(db, key)).toBeNull();
  expect((await rememberLocalRecoveryCheckpoint(db, checkpoint)).changed).toBe(true);
  const before = await db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
  );
  expect(await inspectLocalRecoveryCheckpoint(db, key)).toEqual(checkpoint);
  expect((await rememberLocalRecoveryCheckpoint(db, checkpoint)).changed).toBe(false);
  expect(
    await db.values(sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`),
  ).toEqual(before);
  expect(await db.select().from(localAssetManifestTable)).toEqual([]);
});

it("owns registration input before opening its transaction", async () => {
  const db = await database();
  const input = structuredClone(checkpoint);
  const pending = rememberLocalRecoveryCheckpoint(db, input);
  input.identity.deviceId = "other";
  input.selection.effectSetIds.reverse();
  input.sha256 = "b".repeat(64);
  expect((await pending).checkpoint).toEqual(checkpoint);
  expect(await inspectLocalRecoveryCheckpoint(db, key)).toEqual(checkpoint);
});

it.each([
  { sha256: "b".repeat(64) },
  { byteLength: 643 },
  { selection: { ...selection, baselineId: "other" } },
  { selection: { ...selection, effectSetIds: ["b", "a"] } },
  { identity: { ...checkpoint.identity, schemaId: "0026_local_asset_manifest" } },
])("refuses reuse of a checkpoint identity with different contents %#", async (change) => {
  const db = await database();
  await rememberLocalRecoveryCheckpoint(db, checkpoint);
  const before = await db.values(sql`SELECT * FROM local_recovery_checkpoint`);
  await expect(rememberLocalRecoveryCheckpoint(db, { ...checkpoint, ...change })).rejects.toThrow(
    "different contents",
  );
  expect(await db.values(sql`SELECT * FROM local_recovery_checkpoint`)).toEqual(before);
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId"] as const)(
  "keeps independent %s identities separate",
  async (field) => {
    const db = await database();
    await rememberLocalRecoveryCheckpoint(db, checkpoint);
    const other = { ...checkpoint, identity: { ...checkpoint.identity, [field]: "other" } };
    await rememberLocalRecoveryCheckpoint(db, other);
    expect(await inspectLocalRecoveryCheckpoint(db, { ...key, [field]: "other" })).toEqual(other);
    expect(await inspectLocalRecoveryCheckpoint(db, key)).toEqual(checkpoint);
  },
);

it.each([false, true])(
  "rolls back descriptor and dependent shared publication together (commit=%s)",
  async (commit) => {
    const db = await database();
    await db.insert(namespaceTable).values({ id: "n", name: "Original" });
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_descriptor AFTER INSERT ON local_recovery_checkpoint BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_descriptor BEFORE INSERT ON local_recovery_checkpoint BEGIN SELECT RAISE(ABORT,'descriptor refused'); END`,
      );
    await expect(
      withTx(db, async (tx) => {
        await tx.update(namespaceTable).set({ name: "Uncommitted" });
        await rememberLocalRecoveryCheckpointInTx(tx, checkpoint);
      }),
    ).rejects.toThrow();
    expect(await inspectLocalRecoveryCheckpoint(db, key)).toBeNull();
    expect((await db.select().from(namespaceTable))[0].name).toBe("Original");
    await db.run(sql`DROP TRIGGER reject_descriptor`);
    await rememberLocalRecoveryCheckpoint(db, checkpoint);
  },
);

it("stores a captured descriptor after hashing without including its own registration in the snapshot", async () => {
  const db = await database();
  const captured = await captureLocalRecoveryCheckpoint(
    db,
    checkpoint.identity,
    async () => selection,
  );
  expect(
    captured.snapshot.tables.find((table) => table.name === "local_recovery_checkpoint")!.rows,
  ).toEqual([]);
  await rememberLocalRecoveryCheckpoint(db, captured.checkpoint);
  const stored = await inspectLocalRecoveryCheckpoint(db, key);
  expect(await requireLocalRecoveryCheckpoint(captured.snapshot, stored)).toEqual(
    captured.snapshot,
  );
  const later = await captureLocalRecoverySnapshot(
    db,
    { ...checkpoint.identity, checkpointId: "later" },
    async () => selection,
  );
  expect(
    later.tables.find((table) => table.name === "local_recovery_checkpoint")!.rows,
  ).toHaveLength(1);
});

it("retains known historical descriptor metadata without authorizing historical snapshot loading", async () => {
  const db = await database();
  const older = {
    ...checkpoint,
    identity: { ...checkpoint.identity, schemaId: "0026_local_asset_manifest" },
  };
  await rememberLocalRecoveryCheckpoint(db, older);
  expect(await inspectLocalRecoveryCheckpoint(db, key)).toEqual(older);
  const current = await captureLocalRecoverySnapshot(
    db,
    checkpoint.identity,
    async () => selection,
  );
  await expect(requireLocalRecoveryCheckpoint(current, older)).rejects.toThrow("identity mismatch");
  await validateLocalRecoverySnapshot(database, current, checkpoint.identity);
});

it("preserves catalog records and exact timestamps through shared restoration and local capture", async () => {
  const db = await database();
  await rememberLocalRecoveryCheckpoint(db, checkpoint);
  await db.run(sql`UPDATE local_recovery_checkpoint SET created_at=9223372036854775807`);
  expect((await rememberLocalRecoveryCheckpoint(db, checkpoint)).changed).toBe(false);
  const before = await db.values(
    sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`,
  );
  const capture = await installCapturePrototype(db);
  expect(capturedTables).toHaveLength(12);
  expect(capturedTables.some((table) => table.name === "local_recovery_checkpoint")).toBe(false);
  await capture.restore(database, []);
  expect(
    await db.values(sql`SELECT descriptor,CAST(created_at AS TEXT) FROM local_recovery_checkpoint`),
  ).toEqual(before);
  const local = await captureLocalRecoverySnapshot(db, checkpoint.identity, async () => selection);
  expect(
    local.tables.find((table) => table.name === "local_recovery_checkpoint")!.rows[0].created_at,
  ).toEqual(["integer", "9223372036854775807"]);
});

it.each(["hash", "unknown-schema"])(
  "refuses malformed stored descriptor %s before validation allocates a database",
  async (field) => {
    const db = await database();
    await rememberLocalRecoveryCheckpoint(db, checkpoint);
    const corrupt =
      field === "hash"
        ? { ...checkpoint, sha256: "bad" }
        : { ...checkpoint, identity: { ...checkpoint.identity, schemaId: "unknown-schema" } };
    await db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(corrupt)}`);
    await expect(inspectLocalRecoveryCheckpoint(db, key)).rejects.toThrow();
    const snapshot = await captureLocalRecoverySnapshot(
      db,
      checkpoint.identity,
      async () => selection,
    );
    const create = vi.fn(database);
    await expect(
      validateLocalRecoverySnapshot(create, snapshot, checkpoint.identity),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it("enforces descriptor-to-row identity in SQL", async () => {
  const db = await database();
  await expect(
    db.insert(localRecoveryCheckpointTable).values({
      ...key,
      checkpointId: "other",
      descriptor: JSON.stringify(checkpoint),
      createdAt: new Date(1000),
    }),
  ).rejects.toThrow();
  expect(await db.select().from(localRecoveryCheckpointTable)).toEqual([]);
});

it.each([false, true])(
  "migration 27 preserves prior local evidence and rolls back cleanly (rollback=%s)",
  async (fail) => {
    const db = await database();
    const migration = migrations.find((row) => row.tag === "0027_local_recovery_checkpoint")!;
    await withMigration(db, async () => [
      { sql: "DROP TABLE local_recovery_shared_history", args: [] },
      { sql: "DROP TABLE local_recovery_checkpoint", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      {
        sql: "INSERT INTO taskspace_local VALUES('absent','local/retained','workspace_relative',9007199254740993)",
        args: [],
      },
    ]);
    if (fail) {
      await db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(db)).rejects.toThrow();
      await expect(db.select().from(localRecoveryCheckpointTable)).rejects.toThrow();
      await db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(db)).appliedIds).toEqual(
      migrations.filter((row) => row.when >= migration.when).map((row) => row.id),
    );
    expect(
      String((await db.values(sql`SELECT CAST(last_seen_at AS TEXT) FROM taskspace_local`))[0][0]),
    ).toBe("9007199254740993");
  },
);
