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
import { captureApplicationRows, capturedTables } from "../../test-utils/action-tables.js";
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
async function fixture(
  options: { rich?: boolean; local?: boolean; alter?: (payload: any) => void } = {},
) {
  const source = await runArchiveAssetFixture(),
    assets = await recovery.describeRunArchiveAssets(source),
    bundle = await recovery.describeRecoveryBundleIndex(assets.checkpoint, {
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
  // The core boundary consumes separately trusted descriptors. Complete other payload bytes are validated by the host.
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
  if (options.local !== false)
    await recovery.installLocalRecoverySnapshot(
      destination,
      factory,
      source.localSnapshot,
      checkpoint,
      identity,
    );
  await destination.run(
    sql`INSERT INTO taskspace_local VALUES('absent','device/🪁'||char(0)||'path','workspace_relative',9223372036854775807)`,
  );
  await destination.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.directory',1,'absent','missing','keep','workspace_relative','pending','{}',9007199254740993)`,
  );
  const install = (
    target = destination,
    create = factory,
    input: unknown = shared.payload,
    cp: unknown = checkpoint,
    expected = identity,
  ) => recovery.installSharedRecoverySnapshot(target, create, input, cp, expected);
  return { destination, shared, checkpoint, install };
}
const values = async (
  db: Awaited<ReturnType<typeof factory>>,
  query: Parameters<typeof db.values>[0],
) => (await db.values(query)).map((row) => Array.from(row));
const local = (db: Awaited<ReturnType<typeof factory>>) =>
  recovery.captureLocalRecoverySnapshot(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["rebase", "noop"],
  }));
it("stages all twelve shared tables exactly while preserving local rows and canonical business triggers", async () => {
  const f = await fixture(),
    before = await local(f.destination);
  expect(await f.install()).toEqual({ checkpoint: f.checkpoint, changed: true });
  const installed = await captureRows(f.destination);
  for (const table of f.shared.projection.tables)
    expect(installed.filter((row) => row.table === table.name).map((row) => row.row)).toEqual(
      table.rows,
    );
  expect((await captureRows(f.destination)).map((row) => row.table).sort()).toEqual(
    capturedTables.map((table) => table.name).sort(),
  );
  expect(
    await values(
      f.destination,
      sql`SELECT CAST(pos_x AS TEXT),created_at,updated_at,hex(content) FROM card`,
    ),
  ).toEqual([
    ["9007199254740993", 0, 0, Buffer.from("\ufeffexact\0🪁").toString("hex").toUpperCase()],
  ]);
  expect(await values(f.destination, sql`SELECT CAST(pos_x AS TEXT) FROM warp`)).toEqual([
    ["-9223372036854775808"],
  ]);
  expect(await local(f.destination)).toEqual(before);
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toEqual(f.checkpoint);
  await f.destination.run(
    sql`INSERT INTO card(id,partition_id,layer_id,content) VALUES('ordinary','p','l','New')`,
  );
  expect(
    Number(
      (await values(f.destination, sql`SELECT created_at FROM card WHERE id='ordinary'`))[0][0],
    ),
  ).toBeGreaterThan(0);
});
it("acknowledges matching retries without validation or replaying later local and shared edits", async () => {
  const f = await fixture();
  await f.install();
  await f.destination.run(sql`UPDATE namespace SET name='Later'`);
  await f.destination.run(sql`DELETE FROM card`);
  await f.destination.run(sql`UPDATE taskspace_local SET path='Later local'`);
  const before = await captureRows(f.destination),
    metadata = await local(f.destination),
    create = vi.fn(factory);
  expect(await f.install(f.destination, create)).toEqual({
    checkpoint: f.checkpoint,
    changed: false,
  });
  expect(create).not.toHaveBeenCalled();
  expect(await captureRows(f.destination)).toEqual(before);
  expect(await local(f.destination)).toEqual(metadata);
});
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses mismatched %s before allocating validation databases",
  async (field) => {
    const f = await fixture(),
      create = vi.fn(factory),
      expected = { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" };
    await expect(
      f.install(f.destination, create, f.shared.payload, f.checkpoint, expected),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toBeNull();
  },
);
it.each(["missing", "different"])("requires a matching local installation (%s)", async (kind) => {
  const f = await fixture({ local: kind !== "missing" }),
    create = vi.fn(factory),
    cp = kind === "different" ? { ...f.checkpoint, sha256: "b".repeat(64) } : f.checkpoint;
  await expect(f.install(f.destination, create, f.shared.payload, cp)).rejects.toThrow(
    "matching local installation",
  );
  expect(create).not.toHaveBeenCalled();
});
it("refuses a populated shared destination before SQL validation", async () => {
  const f = await fixture(),
    create = vi.fn(factory);
  await f.destination.run(sql`INSERT INTO namespace VALUES('existing','Keep',0)`);
  await expect(f.install(f.destination, create)).rejects.toThrow("empty shared tables");
  expect(create).not.toHaveBeenCalled();
  expect(await values(f.destination, sql`SELECT name FROM namespace`)).toEqual([["Keep"]]);
});
it.each(["missing", "changed", "selection"])(
  "refuses %s shared history before database allocation",
  async (kind) => {
    const f = await fixture(),
      create = vi.fn(factory),
      payload = structuredClone(f.shared.payload) as any;
    if (kind === "missing") payload.history.effectSets.pop();
    if (kind === "changed")
      payload.history.baseline.projection.tables.find(
        (t: any) => t.name === "namespace",
      ).rows[0].name = ["text", "Changed"];
    if (kind === "selection") payload.selection.effectSets = [];
    await expect(f.install(f.destination, create, payload)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["foreign-key", "inventory-pair"])(
  "refuses invalid final SQL states (%s) without changing the destination",
  async (kind) => {
    const f = await fixture({
        alter: (payload) => {
          const card = payload.history.baseline.projection.tables.find(
            (t: any) => t.name === "card",
          ).rows[0];
          if (kind === "foreign-key") card.partition_id = ["text", "missing"];
          else card.inventory_slot = ["integer", "1"];
        },
      }),
      before = await local(f.destination);
    await expect(f.install()).rejects.toThrow();
    expect(await captureRows(f.destination)).toEqual([]);
    expect(await local(f.destination)).toEqual(before);
    expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toBeNull();
  },
);
it.each(["table", "trigger", "guard", "history"])(
  "refuses unsupported destination %s before validation",
  async (kind) => {
    const f = await fixture(),
      create = vi.fn(factory);
    if (kind === "table") await f.destination.run(sql`CREATE TABLE unsupported(id TEXT)`);
    if (kind === "trigger")
      await f.destination.run(
        sql`CREATE TRIGGER unsupported AFTER INSERT ON namespace BEGIN DELETE FROM namespace; END`,
      );
    if (kind === "guard")
      await f.destination.run(sql`DROP TRIGGER shared_recovery_installation_no_delete`);
    if (kind === "history")
      await f.destination.run(
        sql`DELETE FROM __drizzle_migrations WHERE created_at=${migrations.at(-1)!.when}`,
      );
    await expect(f.install(f.destination, create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it("rechecks empty shared tables after isolated validation yields", async () => {
  const f = await fixture();
  await expect(
    f.install(f.destination, async () => {
      await f.destination.run(sql`INSERT INTO namespace VALUES('race','Keep',0)`);
      return factory();
    }),
  ).rejects.toThrow("empty shared tables");
  expect(await values(f.destination, sql`SELECT name FROM namespace`)).toEqual([["Keep"]]);
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toBeNull();
});
it("preserves local changes made while isolated validation yields", async () => {
  const f = await fixture();
  expect(
    (
      await f.install(f.destination, async () => {
        await f.destination.run(sql`UPDATE taskspace_local SET path='Concurrent edit'`);
        return factory();
      })
    ).changed,
  ).toBe(true);
  expect(await values(f.destination, sql`SELECT path FROM taskspace_local`)).toEqual([
    ["Concurrent edit"],
  ]);
});
it("refuses the destination as its validation database", async () => {
  const f = await fixture();
  await expect(f.install(f.destination, async () => f.destination)).rejects.toThrow(
    "separate validation database",
  );
  expect(await captureRows(f.destination)).toEqual([]);
});
it("rolls back shared rows, receipt and trigger changes after a deferred commit failure", async () => {
  const f = await fixture(),
    before = await local(f.destination);
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
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
  expect(await local(f.destination)).toEqual(before);
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toBeNull();
  expect((await f.install()).changed).toBe(true);
});
it.each(["shared", "local", "schema", "connection-flags"])(
  "refuses %s changes during receipt publication and rolls back",
  async (kind) => {
    const f = await fixture(),
      before = await local(f.destination);
    const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
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
                              await tx.run(sql`UPDATE taskspace_local SET path='Changed'`);
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
    expect(await local(f.destination)).toEqual(before);
    expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toBeNull();
    expect((await f.install()).changed).toBe(true);
  },
);
it("owns shared contents, descriptor and host identity before hashing yields", async () => {
  const f = await fixture(),
    payload = structuredClone(f.shared.payload),
    cp = structuredClone(f.checkpoint),
    expected = { ...identity };
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    (payload as any).history.effectSets = [];
    (cp as any).sha256 = "b".repeat(64);
    expected.deviceId = "Changed";
    return digest(...args);
  });
  expect((await f.install(f.destination, factory, payload, cp, expected)).changed).toBe(true);
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toEqual(f.checkpoint);
});
it("records empty shared staging once and preserves later rows on retry", async () => {
  const f = await fixture({ rich: false });
  expect((await f.install()).changed).toBe(true);
  expect(await captureRows(f.destination)).toEqual([]);
  await f.destination.run(sql`INSERT INTO namespace VALUES('later','Keep',0)`);
  expect((await f.install()).changed).toBe(false);
  expect(await values(f.destination, sql`SELECT name FROM namespace`)).toEqual([["Keep"]]);
});
it("keeps shared installation authority out of portable snapshots and shared projections", async () => {
  const f = await fixture();
  await f.install();
  const snapshot = await local(f.destination);
  expect(snapshot.tables).toHaveLength(14);
  expect(snapshot.tables.some((t) => t.name === "shared_recovery_installation")).toBe(false);
  expect(() =>
    recovery.parseLocalRecoverySnapshot({
      ...snapshot,
      tables: [...snapshot.tables, { name: "shared_recovery_installation", rows: [] }],
    }),
  ).toThrow();
  expect(() =>
    recovery.parseSharedRecoveryProjection({
      ...f.shared.projection,
      tables: [...f.shared.projection.tables, { name: "shared_recovery_installation", rows: [] }],
    }),
  ).toThrow();
});
it("migration 38 preserves the original local record and starts without shared authority", async () => {
  const f = await fixture(),
    migration = migrations.find((record) => record.idx === 38)!;
  await withMigration(f.destination, async () => [
    { sql: "DROP TABLE shared_only_recovery_installation", args: [] },
    { sql: "DROP TABLE shared_recovery_installation", args: [] },
    { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
  ]);
  expect((await applyMigrations(f.destination)).appliedIds).toEqual(
    migrations.filter((record) => record.idx >= 38).map((record) => record.id),
  );
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(f.checkpoint);
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toBeNull();
  expect((await f.install()).changed).toBe(true);
});
it("inspects historical descriptors without converting maximum SQLite timestamps and enforces immutable records", async () => {
  const f = await fixture(),
    historical = structuredClone(f.checkpoint) as any;
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if ("schemaId" in value) value.schemaId = migrations.at(-2)!.id;
    for (const item of Object.values(value)) walk(item);
  };
  walk(historical);
  await f.destination.run(
    sql`INSERT INTO shared_recovery_installation VALUES(1,${JSON.stringify(historical)},9223372036854775807)`,
  );
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toEqual(historical);
  await expect(
    recovery.checkSharedRecoveryInstallation(f.destination, historical, identity),
  ).rejects.toThrow();
  await expect(
    f.destination.run(sql`UPDATE shared_recovery_installation SET installed_at=1`),
  ).rejects.toThrow();
  await expect(f.destination.run(sql`DELETE FROM shared_recovery_installation`)).rejects.toThrow();
});
it.each(["slot", "version", "hash", "length", "time"])(
  "enforces the shared receipt %s constraint",
  async (kind) => {
    const f = await fixture({ rich: false }),
      cp = structuredClone(f.checkpoint) as any;
    if (kind === "version") cp.version = 2;
    if (kind === "hash") cp.sha256 = "a".repeat(64) + "\n";
    if (kind === "length") cp.byteLength = 0;
    await expect(
      f.destination.run(
        sql`INSERT INTO shared_recovery_installation VALUES(${kind === "slot" ? 2 : 1},${JSON.stringify(cp)},${kind === "time" ? -1 : 1})`,
      ),
    ).rejects.toThrow();
  },
);
it("refuses a conflicting shared receipt even when the original local receipt matches", async () => {
  const f = await fixture({ rich: false }),
    create = vi.fn(factory),
    other = { ...f.checkpoint, sha256: "b".repeat(64) };
  await f.destination.run(
    sql`INSERT INTO shared_recovery_installation VALUES(1,${JSON.stringify(other)},1)`,
  );
  await expect(f.install(f.destination, create)).rejects.toThrow("different shared installation");
  expect(create).not.toHaveBeenCalled();
  expect(await recovery.inspectSharedRecoveryInstallation(f.destination)).toEqual(other);
});
