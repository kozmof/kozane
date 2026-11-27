import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  withMigration,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { migrations, applyMigrations } from "@kozane/core/migrations";
import { createTestDB } from "../../test-utils/db.js";
import { captureApplicationRows } from "../../test-utils/action-tables.js";
import { runArchiveAssetFixture } from "../../test-utils/run-archive-assets.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";
beforeEach(async () => {
  if (!crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const factory = () => createTestDB();
const captureRows = (db: Awaited<ReturnType<typeof factory>>) =>
  captureApplicationRows(db as unknown as Parameters<typeof captureApplicationRows>[0]);
async function richRows() {
  const db = await factory();
  for (const statement of [
    "INSERT INTO namespace VALUES('rich','Rich',0)",
    "INSERT INTO scope VALUES('s','Scope')",
    "INSERT INTO partition VALUES('p','rich','Partition',1)",
    "INSERT INTO layer VALUES('l','rich','Layer',0,1)",
    "INSERT INTO taskspace VALUES('t','rich','s','Taskspace',0,0)",
    "INSERT INTO inventory(id,namespace_id,name,pos_x,pos_y) VALUES('i','rich','Inventory',0,0)",
    "INSERT INTO card(id,partition_id,layer_id,taskspace_id,content,pos_x,pos_y,created_at,updated_at) VALUES('c','p','l','t','initial',9007199254740993,1.5,0,0)",
    "INSERT INTO glue VALUES('g')",
    "INSERT INTO glue_rel VALUES('g','c')",
    "INSERT INTO scope_rel VALUES('s','c')",
    "INSERT INTO scope_area(id,scope_id,namespace_id,pos_x,pos_y,width,height) VALUES('a','s','rich',0,0,10,20)",
    "INSERT INTO warp VALUES('w','rich',-9223372036854775808,5e-324)",
    "UPDATE card SET content=char(65279)||'exact'||char(0)||'🪁',created_at=0,updated_at=0",
  ])
    await db.run(sql.raw(statement));
  return captureRows(db);
}
const receiving = { ...identity, deviceId: "receiving-device" };
async function fixture(options: { rich?: boolean; alter?: (payload: any) => void } = {}) {
  const source = await runArchiveAssetFixture(),
    assets = await recovery.describeRunArchiveAssets(source);
  const bundle = await recovery.describeRecoveryBundleIndex(assets.checkpoint, {
    localSnapshot: source.localSnapshot,
    sharedHistory: source.sharedHistory,
    executions: source.executions,
    originalActions: source.originalActions,
    actionArchive: source.actionArchive,
    runArchive: source.runArchive,
    currentAssets: source.currentAssets,
    runAssets: assets.payload,
  });
  const payload = structuredClone(source.sharedHistory);
  if (options.rich !== false) {
    const rows = structuredClone(await richRows());
    for (const table of payload.history.baseline.projection.tables)
      table.rows.push(...rows.filter((row) => row.table === table.name).map((row) => row.row));
  }
  options.alter?.(payload);
  const shared = await recovery.describeSharedRecoveryHistory(
    payload.history,
    identity,
    payload.selection,
  );
  // Core tests independently retain the selected binding. The Node host validates all other bundle bytes.
  const original = JSON.stringify(
    assets.checkpoint.binding.checkpoint.checkpoint.checkpoint.checkpoint.checkpoint,
  );
  const bind = (value: any): any =>
    JSON.stringify(value) === original
      ? shared.checkpoint
      : Array.isArray(value)
        ? value.map(bind)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, bind(value)]))
          : value;
  const checkpoint = recovery.parseRecoveryBundleCheckpoint(bind(bundle.checkpoint));
  const destination = await factory();
  const install = (
    target = destination,
    create = factory,
    input: unknown = shared.payload,
    cp: unknown = checkpoint,
    expected = identity,
    destinationExpected = receiving,
  ) =>
    recovery.installSharedOnlyRecoverySnapshot(
      target,
      create,
      input,
      cp,
      expected,
      destinationExpected,
    );
  return { source, shared, checkpoint, destination, install };
}
const values = async (
  db: Awaited<ReturnType<typeof factory>>,
  query: Parameters<typeof db.values>[0],
) => (await db.values(query)).map((row) => Array.from(row));
async function emptyLocal(db: Awaited<ReturnType<typeof factory>>) {
  const snapshot = await recovery.captureLocalRecoverySnapshot(db, receiving, async () => ({
    baselineId: "baseline",
    effectSetIds: ["rebase", "noop"],
  }));
  expect(snapshot.tables).toHaveLength(14);
  expect(snapshot.tables.every((table) => table.rows.length === 0)).toBe(true);
  expect(await recovery.inspectLocalRecoveryInstallation(db)).toBeNull();
  expect(await recovery.inspectSharedRecoveryInstallation(db)).toBeNull();
}
it("stages exact shared rows for another device with no source local paths, uploads, manifests or operations", async () => {
  const f = await fixture();
  expect(await f.install()).toEqual({
    checkpoint: f.checkpoint,
    destinationIdentity: receiving,
    changed: true,
  });
  const installed = await captureRows(f.destination);
  for (const table of f.shared.projection.tables)
    expect(installed.filter((row) => row.table === table.name).map((row) => row.row)).toEqual(
      table.rows,
    );
  expect(installed).toHaveLength(12);
  await emptyLocal(f.destination);
  expect(
    await values(
      f.destination,
      sql`SELECT CAST(pos_x AS TEXT),created_at,updated_at,hex(content) FROM card`,
    ),
  ).toEqual([
    ["9007199254740993", 0, 0, Buffer.from("\ufeffexact\0🪁").toString("hex").toUpperCase()],
  ]);
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toEqual({
    checkpoint: f.checkpoint,
    destinationIdentity: receiving,
  });
  await f.destination.run(
    sql`INSERT INTO card(id,partition_id,layer_id,content) VALUES('ordinary','p','l','New')`,
  );
  expect(
    Number(
      (await values(f.destination, sql`SELECT created_at FROM card WHERE id='ordinary'`))[0][0],
    ),
  ).toBeGreaterThan(0);
});
it("supports explicit shared-only staging on the originating device without attaching its local data", async () => {
  const f = await fixture();
  expect(
    (await f.install(f.destination, factory, f.shared.payload, f.checkpoint, identity, identity))
      .changed,
  ).toBe(true);
  await emptyLocal(f.destination);
});
it("acknowledges retries without validation and preserves later shared edits and new destination-local attachments", async () => {
  const f = await fixture();
  await f.install();
  await f.destination.run(sql`UPDATE namespace SET name='Later'`);
  await f.destination.run(sql`DELETE FROM card`);
  await f.destination.run(
    sql`INSERT INTO taskspace_local VALUES('later','receiving/only','workspace_relative',9223372036854775807)`,
  );
  const before = await captureRows(f.destination),
    create = vi.fn(factory);
  expect(await f.install(f.destination, create)).toEqual({
    checkpoint: f.checkpoint,
    destinationIdentity: receiving,
    changed: false,
  });
  expect(create).not.toHaveBeenCalled();
  expect(await captureRows(f.destination)).toEqual(before);
  expect(
    await values(f.destination, sql`SELECT path,CAST(last_seen_at AS TEXT) FROM taskspace_local`),
  ).toEqual([["receiving/only", "9223372036854775807"]]);
});
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses a different source %s before validation",
  async (field) => {
    const f = await fixture({ rich: false }),
      create = vi.fn(factory),
      expected = { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" };
    await expect(
      f.install(f.destination, create, f.shared.payload, f.checkpoint, expected),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["workspaceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses a different destination %s before validation",
  async (field) => {
    const f = await fixture({ rich: false }),
      create = vi.fn(factory),
      expected = { ...receiving, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" };
    await expect(
      f.install(f.destination, create, f.shared.payload, f.checkpoint, identity, expected),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["bundle", "device"])(
  "refuses a conflicting %s after shared-only staging",
  async (kind) => {
    const f = await fixture({ rich: false });
    await f.install();
    const create = vi.fn(factory);
    await expect(
      f.install(
        f.destination,
        create,
        f.shared.payload,
        kind === "bundle" ? { ...f.checkpoint, sha256: "b".repeat(64) } : f.checkpoint,
        identity,
        kind === "device" ? { ...receiving, deviceId: "another" } : receiving,
      ),
    ).rejects.toThrow("different shared-only installation");
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["shared", "path", "operation", "local-record", "shared-record"])(
  "refuses a populated %s destination without replacing rows",
  async (kind) => {
    const f = await fixture({ rich: false }),
      create = vi.fn(factory);
    if (kind === "shared")
      await f.destination.run(sql`INSERT INTO namespace VALUES('keep','Keep',0)`);
    if (kind === "path")
      await f.destination.run(
        sql`INSERT INTO taskspace_local VALUES('keep','Keep','workspace_relative',0)`,
      );
    if (kind === "operation")
      await f.destination.run(
        sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.directory',1,'absent','missing','keep','workspace_relative','pending','{}',1)`,
      );
    if (kind === "local-record")
      await f.destination.run(
        sql`INSERT INTO local_recovery_installation VALUES(1,${JSON.stringify(f.checkpoint)},1)`,
      );
    if (kind === "shared-record")
      await f.destination.run(
        sql`INSERT INTO shared_recovery_installation VALUES(1,${JSON.stringify(f.checkpoint)},1)`,
      );
    await expect(f.install(f.destination, create)).rejects.toThrow("empty destination");
    expect(create).not.toHaveBeenCalled();
    expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
  },
);
it.each(["missing", "changed", "selection"])(
  "refuses %s shared contents before SQL allocation",
  async (kind) => {
    const f = await fixture(),
      create = vi.fn(factory),
      input = structuredClone(f.shared.payload) as any;
    if (kind === "missing") input.history.effectSets.pop();
    if (kind === "changed")
      input.history.baseline.projection.tables.find(
        (t: any) => t.name === "namespace",
      ).rows[0].name = ["text", "Changed"];
    if (kind === "selection") input.selection.effectSets = [];
    await expect(f.install(f.destination, create, input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["foreign-key", "inventory-pair"])(
  "refuses invalid SQL states (%s) and preserves the destination",
  async (kind) => {
    const f = await fixture({
      alter: (payload) => {
        const card = payload.history.baseline.projection.tables.find((t: any) => t.name === "card")
          .rows[0];
        if (kind === "foreign-key") card.partition_id = ["text", "missing"];
        else card.inventory_slot = ["integer", "1"];
      },
    });
    await expect(f.install()).rejects.toThrow();
    expect(await captureRows(f.destination)).toEqual([]);
    await emptyLocal(f.destination);
    expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
  },
);
it.each(["table", "trigger", "guard", "history"])(
  "refuses unsupported destination %s before isolated validation",
  async (kind) => {
    const f = await fixture({ rich: false }),
      create = vi.fn(factory);
    if (kind === "table") await f.destination.run(sql`CREATE TABLE unsupported(id TEXT)`);
    if (kind === "trigger")
      await f.destination.run(
        sql`CREATE TRIGGER unsupported AFTER INSERT ON namespace BEGIN DELETE FROM namespace; END`,
      );
    if (kind === "guard")
      await f.destination.run(sql`DROP TRIGGER shared_only_recovery_installation_no_delete`);
    if (kind === "history")
      await f.destination.run(
        sql`DELETE FROM __drizzle_migrations WHERE created_at=${migrations.at(-1)!.when}`,
      );
    await expect(f.install(f.destination, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it("rechecks destination emptiness after isolated validation yields", async () => {
  const f = await fixture();
  await expect(
    f.install(f.destination, async () => {
      await f.destination.run(
        sql`INSERT INTO taskspace_local VALUES('race','Keep','workspace_relative',0)`,
      );
      return factory();
    }),
  ).rejects.toThrow("empty destination");
  expect(await captureRows(f.destination)).toEqual([]);
  expect(await values(f.destination, sql`SELECT path FROM taskspace_local`)).toEqual([["Keep"]]);
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
});
it("refuses the destination as its validation database", async () => {
  const f = await fixture();
  await expect(f.install(f.destination, async () => f.destination)).rejects.toThrow(
    "separate validation database",
  );
  expect(await captureRows(f.destination)).toEqual([]);
});
it("rolls back rows, metadata and business trigger changes after a failed outer commit", async () => {
  const f = await fixture(),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(f.destination, async (tx) => {
          const result = await work(tx);
          await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
          await tx.run(
            sql`CREATE TABLE deferred_child(id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
          );
          await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
          return result;
        }),
    });
  await expect(f.install(wrapped)).rejects.toThrow();
  expect(await captureRows(f.destination)).toEqual([]);
  await emptyLocal(f.destination);
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
  expect((await f.install()).changed).toBe(true);
});
it.each(["shared", "local", "schema", "connection-flags"])(
  "rolls back after %s changes during record publication",
  async (kind) => {
    const f = await fixture(),
      wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
        read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
        write: (work) =>
          withTx(f.destination, (tx) =>
            work(
              new Proxy(tx, {
                get(target, key) {
                  if (key === "insert")
                    return (...args: Parameters<typeof tx.insert>) => {
                      const insertion = target.insert(...args);
                      return new Proxy(insertion, {
                        get(value, property) {
                          if (property === "values")
                            return async (...values: Parameters<typeof insertion.values>) => {
                              await value.values(...values);
                              if (kind === "shared") await tx.run(sql`UPDATE card SET pos_x=1.25`);
                              if (kind === "local")
                                await tx.run(
                                  sql`INSERT INTO taskspace_local VALUES('unexpected','Refuse','workspace_relative',0)`,
                                );
                              if (kind === "schema")
                                await tx.run(sql`DROP TRIGGER card_stamp_missing_timestamps`);
                              if (kind === "connection-flags")
                                await tx.values(sql`PRAGMA recursive_triggers=OFF`);
                            };
                          const result = Reflect.get(value, property, value);
                          return typeof result === "function" ? result.bind(value) : result;
                        },
                      });
                    };
                  const result = Reflect.get(target, key, target);
                  return typeof result === "function" ? result.bind(target) : result;
                },
              }),
            ),
          ),
      });
    await expect(f.install(wrapped)).rejects.toThrow();
    expect(await captureRows(f.destination)).toEqual([]);
    await emptyLocal(f.destination);
    expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
    expect((await f.install()).changed).toBe(true);
  },
);
it("owns source contents, bundle and both identities before hashing yields", async () => {
  const f = await fixture(),
    input = structuredClone(f.shared.payload),
    cp = structuredClone(f.checkpoint) as any,
    expected = { ...identity },
    target = { ...receiving };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    (input as any).history.effectSets = [];
    cp.sha256 = "b".repeat(64);
    expected.deviceId = "Changed";
    target.deviceId = "Changed";
    return digest(...args);
  });
  expect((await f.install(f.destination, factory, input, cp, expected, target)).changed).toBe(true);
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toEqual({
    checkpoint: f.checkpoint,
    destinationIdentity: receiving,
  });
});
it("records an empty shared-only projection once and refuses later source-local or complete shared installation", async () => {
  const f = await fixture({ rich: false });
  expect((await f.install()).changed).toBe(true);
  expect(await captureRows(f.destination)).toEqual([]);
  await expect(
    recovery.installLocalRecoverySnapshot(
      f.destination,
      factory,
      f.source.localSnapshot,
      f.checkpoint,
      identity,
    ),
  ).rejects.toThrow("empty destination");
  await expect(
    recovery.installSharedRecoverySnapshot(
      f.destination,
      factory,
      f.shared.payload,
      f.checkpoint,
      identity,
    ),
  ).rejects.toThrow("matching local installation");
  await f.destination.run(sql`INSERT INTO namespace VALUES('later','Keep',0)`);
  expect((await f.install()).changed).toBe(false);
  expect(await values(f.destination, sql`SELECT name FROM namespace`)).toEqual([["Keep"]]);
});
it("keeps shared-only authority out of portable snapshots and shared projections", async () => {
  const f = await fixture();
  await f.install();
  const snapshot = await recovery.captureLocalRecoverySnapshot(
    f.destination,
    receiving,
    async () => ({ baselineId: "baseline", effectSetIds: ["rebase", "noop"] }),
  );
  expect(snapshot.tables).toHaveLength(14);
  expect(snapshot.tables.some((t) => t.name === "shared_only_recovery_installation")).toBe(false);
  expect(() =>
    recovery.parseLocalRecoverySnapshot({
      ...snapshot,
      tables: [...snapshot.tables, { name: "shared_only_recovery_installation", rows: [] }],
    }),
  ).toThrow();
  expect(() =>
    recovery.parseSharedRecoveryProjection({
      ...f.shared.projection,
      tables: [
        ...f.shared.projection.tables,
        { name: "shared_only_recovery_installation", rows: [] },
      ],
    }),
  ).toThrow();
});
it("migration 39 preserves earlier staging records and starts without shared-only authority", async () => {
  const f = await fixture({ rich: false }),
    migration = migrations.at(-1)!;
  await f.destination.run(
    sql`INSERT INTO local_recovery_installation VALUES(1,${JSON.stringify(f.checkpoint)},9223372036854775807)`,
  );
  await withMigration(f.destination, async () => [
    { sql: "DROP TABLE shared_only_recovery_installation", args: [] },
    { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
  ]);
  expect((await applyMigrations(f.destination)).appliedIds).toEqual([migration.id]);
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(f.checkpoint);
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
});
it("reads historical records and maximum timestamps without authorizing installation and enforces immutable records", async () => {
  const f = await fixture({ rich: false }),
    cp = structuredClone(f.checkpoint) as any,
    target = { ...receiving, schemaId: migrations.at(-2)!.id };
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if ("schemaId" in value) value.schemaId = target.schemaId;
    for (const item of Object.values(value)) walk(item);
  };
  walk(cp);
  await f.destination.run(
    sql`INSERT INTO shared_only_recovery_installation VALUES(1,${JSON.stringify(cp)},${JSON.stringify(target)},9223372036854775807)`,
  );
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toEqual({
    checkpoint: cp,
    destinationIdentity: target,
  });
  await expect(
    recovery.checkSharedOnlyRecoveryInstallation(f.destination, cp, identity, receiving),
  ).rejects.toThrow();
  await expect(
    f.destination.run(sql`UPDATE shared_only_recovery_installation SET installed_at=1`),
  ).rejects.toThrow();
  await expect(
    f.destination.run(sql`DELETE FROM shared_only_recovery_installation`),
  ).rejects.toThrow();
});
it.each([
  "slot",
  "version",
  "hash",
  "length",
  "time",
  "deviceId",
  "workspaceId",
  "epochId",
  "checkpointId",
  "schemaId",
])("enforces the shared-only record %s constraint", async (kind) => {
  const f = await fixture({ rich: false }),
    cp = structuredClone(f.checkpoint) as any,
    target = { ...receiving } as any;
  if (kind === "version") cp.version = 2;
  if (kind === "hash") cp.sha256 = "a".repeat(64) + "\n";
  if (kind === "length") cp.byteLength = 0;
  if (["workspaceId", "epochId", "checkpointId", "schemaId"].includes(kind))
    target[kind] = "Mismatch";
  if (kind === "deviceId") target.deviceId = null;
  await expect(
    f.destination.run(
      sql`INSERT INTO shared_only_recovery_installation VALUES(${kind === "slot" ? 2 : 1},${JSON.stringify(cp)},${JSON.stringify(target)},${kind === "time" ? -1 : 1})`,
    ),
  ).rejects.toThrow();
});
it("refuses temporary tables that shadow canonical destination tables under the writer lock", async () => {
  const f = await fixture(),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(f.destination, async (tx) => {
          const definition = (
            await tx.values(sql`SELECT sql FROM sqlite_schema WHERE name='namespace'`)
          )[0][0];
          if (typeof definition !== "string") throw Error("Missing namespace schema");
          await tx.run(sql.raw(definition.replace("CREATE TABLE", "CREATE TEMP TABLE")));
          return work(tx);
        }),
    });
  await expect(f.install(wrapped)).rejects.toThrow("temporary schema objects");
  expect(await captureRows(f.destination)).toEqual([]);
  await emptyLocal(f.destination);
  expect(await recovery.inspectSharedOnlyRecoveryInstallation(f.destination)).toBeNull();
});
