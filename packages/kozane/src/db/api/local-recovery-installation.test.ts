import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  withMigration,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations, applyMigrations } from "@kozane/core/migrations";
import * as recovery from "@kozane/core/recovery";
import { runArchiveAssetFixture } from "../../test-utils/run-archive-assets.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";

beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const factory = () => createTestDB();
async function fixture(empty = false) {
  const source = await factory(),
    f = await runArchiveAssetFixture();
  if (!empty) {
    await source.run(
      sql`INSERT INTO taskspace_local VALUES('absent','local/🪁'||char(0)||'file','workspace_relative',9007199254740993)`,
    );
    await source.run(
      sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.directory',1,'absent','missing','local/layout','workspace_relative','pending','{}',9007199254740993)`,
    );
  }
  const local = await recovery.captureLocalRecoveryCheckpoint(
    source,
    identity,
    async () => f.localSnapshot.selection,
  );
  const current = await recovery.describeRecoveryAssets({
    binding: {
      checkpoint: f.assetCheckpoint.binding.checkpoint,
      localCheckpoint: local.checkpoint,
    },
    localSnapshot: local.snapshot,
    sharedHistory: f.sharedHistory,
    history: f.currentAssets.history,
  });
  f.binding.localCheckpoint = local.checkpoint;
  f.assetCheckpoint = current.checkpoint;
  f.localSnapshot = local.snapshot;
  f.currentAssets = current.payload;
  const assets = await recovery.describeRunArchiveAssets(f);
  const bundle = await recovery.describeRecoveryBundleIndex(assets.checkpoint, {
    localSnapshot: f.localSnapshot,
    sharedHistory: f.sharedHistory,
    executions: f.executions,
    originalActions: f.originalActions,
    actionArchive: f.actionArchive,
    runArchive: f.runArchive,
    currentAssets: f.currentAssets,
    runAssets: assets.payload,
  });
  const destination = await factory();
  const install = (
    target = destination,
    create = factory,
    input: unknown = local.snapshot,
    checkpoint: unknown = bundle.checkpoint,
    expected = identity,
  ) => recovery.installLocalRecoverySnapshot(target, create, input, checkpoint, expected);
  return { source, destination, local, bundle, install };
}
const rows = async (db: Awaited<ReturnType<typeof factory>>) =>
  Object.fromEntries(
    (
      await recovery.captureLocalRecoverySnapshot(db, identity, async () => ({
        baselineId: "baseline",
        effectSetIds: [],
      }))
    ).tables.map((table) => [table.name, table.rows]),
  );
const values = async (
  db: Awaited<ReturnType<typeof factory>>,
  query: Parameters<typeof db.values>[0],
) => (await db.values(query)).map((row) => Array.from(row));

it("installs exact local rows and commits one destination-owned receipt", async () => {
  const f = await fixture();
  expect(await f.install()).toEqual({ checkpoint: f.bundle.checkpoint, changed: true });
  const captured = await recovery.captureLocalRecoverySnapshot(
    f.destination,
    identity,
    async () => f.local.snapshot.selection,
  );
  expect(captured).toEqual(f.local.snapshot);
  expect(captured.tables).toHaveLength(14);
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(
    f.bundle.checkpoint,
  );
  expect(
    await values(
      f.destination,
      sql`SELECT CAST(last_seen_at AS TEXT),hex(path) FROM taskspace_local`,
    ),
  ).toEqual([["9007199254740993", Buffer.from("local/🪁\0file").toString("hex").toUpperCase()]]);
  expect(
    await values(
      f.destination,
      sql`SELECT state,CAST(created_at AS TEXT) FROM local_file_operation`,
    ),
  ).toEqual([["pending", "9007199254740993"]]);
  expect(await f.destination.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});
it("acknowledges matching retries without replaying later local or shared edits", async () => {
  const f = await fixture();
  await f.install();
  const receipt = await f.destination.values(
    sql`SELECT descriptor,CAST(installed_at AS TEXT) FROM local_recovery_installation`,
  );
  await f.destination.run(sql`UPDATE taskspace_local SET path='later edit',last_seen_at=3`);
  await f.destination.run(sql`INSERT INTO namespace VALUES('later','Later',0)`);
  const before = await rows(f.destination),
    create = vi.fn(factory);
  expect(await f.install(f.destination, create)).toEqual({
    checkpoint: f.bundle.checkpoint,
    changed: false,
  });
  expect(create).not.toHaveBeenCalled();
  expect(await rows(f.destination)).toEqual(before);
  expect(
    await f.destination.values(
      sql`SELECT descriptor,CAST(installed_at AS TEXT) FROM local_recovery_installation`,
    ),
  ).toEqual(receipt);
});
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses mismatched %s before validation or writes",
  async (field) => {
    const f = await fixture(),
      create = vi.fn(factory),
      expected = { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" };
    await expect(
      f.install(f.destination, create, f.local.snapshot, f.bundle.checkpoint, expected),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
  },
);
it.each(["missing", "changed", "selection"])(
  "refuses %s snapshot contents before validation allocation",
  async (change) => {
    const f = await fixture(),
      input = JSON.parse(JSON.stringify(f.local.snapshot)),
      create = vi.fn(factory);
    if (change === "missing") input.tables.pop();
    if (change === "changed")
      input.tables.find((t: any) => t.name === "taskspace_local").rows[0].path = [
        "text",
        "changed",
      ];
    if (change === "selection") input.selection.effectSetIds = [];
    await expect(f.install(f.destination, create, input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
  },
);
it.each(["local", "shared", "catalog"])(
  "refuses a populated %s destination before validation",
  async (kind) => {
    const f = await fixture(),
      create = vi.fn(factory);
    if (kind === "local")
      await f.destination.run(
        sql`INSERT INTO taskspace_local VALUES('existing','keep','workspace_relative',0)`,
      );
    if (kind === "shared") await f.destination.run(sql`INSERT INTO namespace VALUES('n','Keep',0)`);
    if (kind === "catalog")
      await recovery.rememberLocalRecoveryCheckpoint(f.destination, f.local.checkpoint);
    const before = await rows(f.destination);
    await expect(f.install(f.destination, create)).rejects.toThrow("empty destination");
    expect(create).not.toHaveBeenCalled();
    expect(await rows(f.destination)).toEqual(before);
  },
);
it("refuses a different bundle after installation without changing any local data", async () => {
  const f = await fixture();
  await f.install();
  const before = await rows(f.destination),
    cp = { ...f.bundle.checkpoint, sha256: "b".repeat(64) };
  await expect(f.install(f.destination, factory, f.local.snapshot, cp)).rejects.toThrow(
    "different local installation",
  );
  expect(await rows(f.destination)).toEqual(before);
});
it("rolls back all rows and the receipt after a deferred commit failure", async () => {
  const f = await fixture();
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.destination, async (tx) => {
        const result = await work(tx);
        await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
        await tx.run(
          sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
        );
        await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
        return result;
      }),
  });
  await expect(f.install(wrapped)).rejects.toThrow();
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
  expect((await rows(f.destination)).taskspace_local).toEqual([]);
  expect((await rows(f.destination)).local_file_operation).toEqual([]);
  expect((await f.install()).changed).toBe(true);
});
it("refuses rows changed by receipt publication and rolls back the complete attempt", async () => {
  const f = await fixture();
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(f.destination, async (tx) => {
        const proxy = new Proxy(tx, {
          get(target, property) {
            if (property === "insert")
              return (...args: Parameters<typeof tx.insert>) => {
                const insertion = target.insert(...args);
                return new Proxy(insertion, {
                  get(value, key) {
                    if (key === "values")
                      return async (...values: Parameters<typeof insertion.values>) => {
                        await value.values(...values);
                        await tx.run(sql`UPDATE taskspace_local SET path='coerced'`);
                      };
                    const result = Reflect.get(value, key, value);
                    return typeof result === "function" ? result.bind(value) : result;
                  },
                });
              };
            const result = Reflect.get(target, property, target);
            return typeof result === "function" ? result.bind(target) : result;
          },
        });
        return work(proxy);
      }),
  });
  await expect(f.install(wrapped)).rejects.toThrow();
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
  expect((await rows(f.destination)).taskspace_local).toEqual([]);
});
it("rechecks destination emptiness after isolated validation yields", async () => {
  const f = await fixture();
  let changed = false;
  await expect(
    f.install(f.destination, async () => {
      if (!changed) {
        changed = true;
        await f.destination.run(
          sql`INSERT INTO taskspace_local VALUES('new','Keep','workspace_relative',1)`,
        );
      }
      return factory();
    }),
  ).rejects.toThrow("empty destination");
  expect(await values(f.destination, sql`SELECT path FROM taskspace_local`)).toEqual([["Keep"]]);
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
});
it("refuses using the destination itself for isolated validation", async () => {
  const f = await fixture();
  await expect(f.install(f.destination, async () => f.destination)).rejects.toThrow(
    "separate validation",
  );
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
});
it("copies rows, identity and expected descriptor before hashing yields", async () => {
  const f = await fixture(),
    input = JSON.parse(JSON.stringify(f.local.snapshot)),
    expected = { ...identity },
    cp = JSON.parse(JSON.stringify(f.bundle.checkpoint)),
    digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce((algorithm, data) => {
    input.tables.length = 0;
    expected.deviceId = "other";
    cp.sha256 = "b".repeat(64);
    return digest(algorithm, data);
  });
  expect((await f.install(f.destination, factory, input, cp, expected)).changed).toBe(true);
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(
    f.bundle.checkpoint,
  );
});
it.each(["extra-table", "extra-trigger", "missing-guard"])(
  "refuses %s destination schemas before validation",
  async (change) => {
    const f = await fixture(),
      create = vi.fn(factory);
    if (change === "extra-table") await f.destination.run(sql`CREATE TABLE unsupported(id TEXT)`);
    if (change === "extra-trigger")
      await f.destination.run(
        sql`CREATE TRIGGER unsupported AFTER INSERT ON taskspace_local BEGIN DELETE FROM taskspace_local; END`,
      );
    if (change === "missing-guard")
      await f.destination.run(sql`DROP TRIGGER local_recovery_installation_no_delete`);
    await expect(f.install(f.destination, create)).rejects.toThrow("canonical destination");
    expect(create).not.toHaveBeenCalled();
  },
);
it("keeps destination authority out of portable snapshots and shared projections", async () => {
  const f = await fixture();
  await f.install();
  const snapshot = await recovery.captureLocalRecoverySnapshot(
    f.destination,
    identity,
    async () => f.local.snapshot.selection,
  );
  expect(snapshot.tables.some((t) => t.name === "local_recovery_installation")).toBe(false);
  expect(() =>
    recovery.parseLocalRecoverySnapshot({
      ...snapshot,
      tables: [...snapshot.tables, { name: "local_recovery_installation", rows: [] }],
    }),
  ).toThrow();
  const { capturedTables } = await import("../../test-utils/action-tables.js");
  expect(capturedTables).toHaveLength(12);
  expect(capturedTables.some((t) => t.name === "local_recovery_installation")).toBe(false);
});
it("reads exact receipt metadata without converting maximum SQLite timestamps", async () => {
  const f = await fixture();
  await f.destination.run(
    sql`INSERT INTO local_recovery_installation VALUES(1,${JSON.stringify(f.bundle.checkpoint)},9223372036854775807)`,
  );
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(
    f.bundle.checkpoint,
  );
  await expect(
    f.destination.run(sql`UPDATE local_recovery_installation SET installed_at=1`),
  ).rejects.toThrow();
  await expect(f.destination.run(sql`DELETE FROM local_recovery_installation`)).rejects.toThrow();
});
it.each(["slot", "version", "hash", "length", "time"])(
  "enforces the %s receipt constraint",
  async (change) => {
    const f = await fixture(),
      cp = JSON.parse(JSON.stringify(f.bundle.checkpoint));
    if (change === "version") cp.version = 2;
    if (change === "hash") cp.sha256 = "a".repeat(64) + "\n";
    if (change === "length") cp.byteLength = 0;
    await expect(
      f.destination.run(
        sql`INSERT INTO local_recovery_installation VALUES(${change === "slot" ? 2 : 1},${JSON.stringify(cp)},${change === "time" ? -1 : 1})`,
      ),
    ).rejects.toThrow();
  },
);
it("migration 37 preserves portable metadata and starts without installation authority", async () => {
  const f = await fixture(),
    migration = migrations.find((record) => record.idx === 37)!;
  await withMigration(f.source, async () => [
    { sql: "DROP TABLE shared_only_recovery_installation", args: [] },
    { sql: "DROP TABLE shared_recovery_installation", args: [] },
    { sql: "DROP TABLE local_recovery_installation", args: [] },
    { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
  ]);
  const before = await rows(f.source);
  expect((await applyMigrations(f.source)).appliedIds).toEqual(
    migrations.filter((record) => record.idx >= 37).map((record) => record.id),
  );
  expect(await rows(f.source)).toEqual(before);
  expect(await recovery.inspectLocalRecoveryInstallation(f.source)).toBeNull();
});
it("records an empty local snapshot once and preserves edits on retry", async () => {
  const f = await fixture(true);
  expect((await f.install()).changed).toBe(true);
  expect(Object.values(await rows(f.destination)).every((list) => list.length === 0)).toBe(true);
  await f.destination.run(
    sql`INSERT INTO taskspace_local VALUES('later','Keep','workspace_relative',1)`,
  );
  expect((await f.install()).changed).toBe(false);
  expect(await values(f.destination, sql`SELECT path FROM taskspace_local`)).toEqual([["Keep"]]);
});
it("keeps historical receipt metadata inspectable without authorizing an old-schema load", async () => {
  const f = await fixture(),
    cp = JSON.parse(JSON.stringify(f.bundle.checkpoint));
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if ("schemaId" in value) value.schemaId = migrations.at(-2)!.id;
    for (const child of Object.values(value)) visit(child);
  };
  visit(cp);
  await f.destination.run(
    sql`INSERT INTO local_recovery_installation VALUES(1,${JSON.stringify(cp)},1)`,
  );
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(cp);
  await expect(
    recovery.checkLocalRecoveryInstallation(f.destination, cp, {
      ...identity,
      schemaId: migrations.at(-2)!.id,
    }),
  ).rejects.toThrow("Unsupported");
});
it.each(["missing", "hash"])(
  "requires complete migration history before installing (%s)",
  async (change) => {
    const f = await fixture(),
      create = vi.fn(factory);
    if (change === "missing")
      await f.destination.run(
        sql`DELETE FROM __drizzle_migrations WHERE created_at=${migrations.at(-1)!.when}`,
      );
    else
      await f.destination.run(
        sql`UPDATE __drizzle_migrations SET hash='changed' WHERE created_at=${migrations.at(-1)!.when}`,
      );
    await expect(f.install(f.destination, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toBeNull();
  },
);
