import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { createTestDB } from "../../test-utils/db.js";
import { createDatabaseAdapter, withTx, type DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import {
  captureLocalRecoverySnapshot,
  type LocalRecoverySnapshot,
} from "../../../../core/src/actions/local-recovery.js";
import { validateLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-validation.js";
import type { TaggedValue } from "../../../../core/src/actions/row-codec.js";
const keys = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const selected = { baselineId: "baseline", effectSetIds: ["origin-a", "origin-b"] };
const database = async () => (await createTestDB()) as unknown as DB;
const capture = (db: DB) => captureLocalRecoverySnapshot(db, keys, async () => selected);
async function fixture() {
  const source = await database();
  await source.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/🪁' || char(0) || 'file','workspace_relative',9223372036854775807)`,
  );
  await source.run(
    sql`INSERT INTO taskspace_local VALUES('blob',X'00ff','workspace_relative',1.5)`,
  );
  await source.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES('pending','taskspace.file',1,'absent','absent-namespace','local/file','workspace_relative','pending','{}',-9223372036854775808,'Original error' || char(0) || '🪁')`,
  );
  await source.run(
    sql`INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at,error) VALUES('00000000-0000-4000-8000-000000000001.svg',3,${"a".repeat(64)},'pending',9007199254740993,'Upload interrupted')`,
  );
  await source.run(
    sql`INSERT INTO local_asset_manifest(owner_kind,owner_id,manifest,state,created_at,released_at,release_reason) VALUES('recovery','old-checkpoint','{"version":1,"entries":[]}','released',0,9007199254740993,'Retired')`,
  );
  const snapshot = await capture(source);
  const target = await database();
  const before = await capture(target);
  const create = vi.fn(async () => target);
  const validate = (input: unknown = snapshot) =>
    validateLocalRecoverySnapshot(create, input, keys);
  const unchanged = async () => {
    expect(await capture(source)).toEqual(snapshot);
    expect(await capture(target)).toEqual(before);
  };
  return { source, snapshot, target, create, validate, unchanged };
}
function changed(
  snapshot: LocalRecoverySnapshot,
  table: string,
  column: string,
  value: TaggedValue,
) {
  return {
    ...snapshot,
    tables: snapshot.tables.map((entry) =>
      entry.name === table
        ? { ...entry, rows: entry.rows.map((row) => ({ ...row, [column]: value })) }
        : entry,
    ),
  };
}

it("validates exact local values under SQL constraints and removes temporary rows before returning", async () => {
  const f = await fixture();
  const schema = await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
  const checked = await f.validate();
  expect(checked).toEqual(f.snapshot);
  expect(checked).not.toBe(f.snapshot);
  expect(Object.isFrozen(checked)).toBe(true);
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.unchanged();
  expect(await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`)).toEqual(
    schema,
  );
  await f.validate();
  await f.unchanged();
});

it("validates an initial snapshot with no local records", async () => {
  const source = await database();
  const snapshot = await capture(source);
  const target = await database();
  expect(await validateLocalRecoverySnapshot(async () => target, snapshot, keys)).toEqual(snapshot);
  expect(await capture(target)).toEqual(snapshot);
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses mismatched %s before calling the factory",
  async (field) => {
    const f = await fixture();
    await expect(
      f.validate({ ...f.snapshot, identity: { ...keys, [field]: "other" } }),
    ).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    await f.unchanged();
  },
);

it("refuses incomplete transport before opening a validation database", async () => {
  const f = await fixture();
  await expect(f.validate({ ...f.snapshot, tables: [] })).rejects.toThrow("Incomplete");
  expect(f.create).not.toHaveBeenCalled();
  await f.unchanged();
});

it.each([
  ["local_file_operation", "state", ["text", "unknown"]],
  ["local_file_operation", "confirmed_at", ["integer", "1"]],
  ["local_file_operation", "path_kind", ["text", "remote"]],
  ["local_image_upload", "byte_length", ["integer", "0"]],
  ["local_image_upload", "created_at", ["null"]],
  ["local_image_upload", "filename", ["text", "../image.svg"]],
  ["local_asset_manifest", "manifest", ["text", "{invalid"]],
  ["local_asset_manifest", "owner_kind", ["text", "unknown"]],
  ["local_asset_manifest", "release_reason", ["null"]],
] as const)("refuses a SQL constraint violation in %s.%s", async (table, column, value) => {
  const f = await fixture();
  await expect(f.validate(changed(f.snapshot, table, column, value))).rejects.toThrow();
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.unchanged();
});

it.each([
  ["last_seen_at", ["real", "3ff0000000000000"]],
  ["last_seen_at", ["real", "8000000000000000"]],
  ["path", ["integer", "9007199254740993"]],
] as const)("refuses affinity changes to exact tagged %s values", async (column, value) => {
  const f = await fixture();
  await expect(f.validate(changed(f.snapshot, "taskspace_local", column, value))).rejects.toThrow(
    "differs from projection",
  );
  await f.unchanged();
});

it.each(["local", "shared"] as const)(
  "refuses a database with existing %s rows before loading anything",
  async (kind) => {
    const f = await fixture();
    if (kind === "local")
      await f.target.run(
        sql`INSERT INTO taskspace_local VALUES('existing','keep','workspace_relative',0)`,
      );
    else await f.target.run(sql`INSERT INTO namespace(id,name) VALUES('existing','Keep')`);
    const before = await capture(f.target);
    await expect(f.validate()).rejects.toThrow("empty database");
    expect(await capture(f.target)).toEqual(before);
    if (kind === "shared")
      expect((await f.target.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Keep");
  },
);

it.each(["column", "trigger"] as const)(
  "refuses an unexpected validation schema %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "column")
      await f.target.run(sql`ALTER TABLE taskspace_local ADD COLUMN unrecorded TEXT`);
    else
      await f.target.run(
        sql`CREATE TRIGGER unexpected AFTER INSERT ON taskspace_local BEGIN UPDATE taskspace_local SET path='Changed'; END`,
      );
    const objects = await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
    await expect(f.validate()).rejects.toThrow("canonical schema");
    expect(await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`)).toEqual(
      objects,
    );
    expect(await f.target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
  },
);

it.each(["rows", "connection-flags"] as const)(
  "rejects changed %s and rolls back the validation rows",
  async (change) => {
    const f = await fixture();
    let changedReadback = false;
    const wrapped = createDatabaseAdapter(new Proxy(f.target, {}), {
      read: async () => {
        throw new Error("Unexpected read boundary");
      },
      write: (operation) =>
        withTx(f.target, (tx) =>
          operation(
            new Proxy(tx, {
              get(target, property) {
                if (property === "values")
                  return async (query: Parameters<typeof tx.values>[0]) => {
                    if (
                      !changedReadback &&
                      (await tx.values(sql`SELECT 1 FROM taskspace_local LIMIT 1`)).length
                    ) {
                      changedReadback = true;
                      if (change === "rows")
                        await tx.run(
                          sql`UPDATE taskspace_local SET path='Changed during read-back'`,
                        );
                      else await tx.values(sql`PRAGMA recursive_triggers=OFF`);
                    }
                    return tx.values(query);
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
    });
    await expect(
      validateLocalRecoverySnapshot(async () => wrapped, f.snapshot, keys),
    ).rejects.toThrow(change === "rows" ? "differs from projection" : "recursive_triggers");
    expect(changedReadback).toBe(true);
    await f.unchanged();
  },
);

it.each(["ROLLBACK TO local_recovery_validation", "RELEASE local_recovery_validation"])(
  "refuses success after %s fails and rolls back the outer transaction",
  async (boundary) => {
    const f = await fixture();
    const dialect = new SQLiteAsyncDialect();
    const wrapped = createDatabaseAdapter(new Proxy(f.target, {}), {
      read: async () => {
        throw new Error("Unexpected read boundary");
      },
      write: (operation) =>
        withTx(f.target, (tx) =>
          operation(
            new Proxy(tx, {
              get(target, property) {
                if (property === "run")
                  return (query: Parameters<typeof tx.run>[0]) => {
                    if (
                      (typeof query === "string"
                        ? query
                        : dialect.sqlToQuery(query.getSQL()).sql) === boundary
                    )
                      throw new Error("Validation cleanup failed");
                    return tx.run(query);
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
    });
    await expect(
      validateLocalRecoverySnapshot(async () => wrapped, f.snapshot, keys),
    ).rejects.toThrow("Validation cleanup failed");
    await f.unchanged();
    await f.validate();
  },
);

it("does not return validation success after the adapter's commit fails", async () => {
  const f = await fixture();
  const objects = await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
  const wrapped = createDatabaseAdapter(new Proxy(f.target, {}), {
    read: async () => {
      throw new Error("Unexpected read boundary");
    },
    write: (operation) =>
      withTx(f.target, async (tx) => {
        const result = await operation(tx);
        await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
        await tx.run(
          sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
        );
        await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
        return result;
      }),
  });
  await expect(
    validateLocalRecoverySnapshot(async () => wrapped, f.snapshot, keys),
  ).rejects.toThrow();
  expect(await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`)).toEqual(
    objects,
  );
  await f.unchanged();
  await f.validate();
});

it("owns transport before awaiting the validation database factory", async () => {
  const f = await fixture();
  const value = JSON.parse(JSON.stringify(f.snapshot)) as {
    identity: { deviceId: string };
    tables: unknown[];
  };
  const checked = await validateLocalRecoverySnapshot(
    async () => {
      value.identity.deviceId = "other";
      value.tables.length = 0;
      return f.target;
    },
    value,
    keys,
  );
  expect(checked).toEqual(f.snapshot);
  await f.unchanged();
});

it("propagates factory failures without changing the source", async () => {
  const f = await fixture();
  await expect(
    validateLocalRecoverySnapshot(
      async () => {
        throw new Error("Factory failed");
      },
      f.snapshot,
      keys,
    ),
  ).rejects.toThrow("Factory failed");
  await f.unchanged();
});
