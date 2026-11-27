import { expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  parseSharedRecoveryProjection,
  validateSharedRecoveryProjection,
  type SharedRecoveryProjection,
} from "../../../../core/src/actions/shared-recovery.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { createDatabaseAdapter, withTx, type DB } from "../../../../core/src/database.js";
import { createTestDB } from "../../test-utils/db.js";
import { captureApplicationRows, capturedTables } from "../../test-utils/action-tables.js";
import * as tables from "../../../../core/src/schema.js";
import type { TaggedRow } from "../../../../core/src/actions/row-codec.js";

const database = async () => (await createTestDB()) as unknown as DB;
const schema = (db: DB) => db.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
async function fixture() {
  const source = await database();
  await source
    .insert(tables.namespaceTable)
    .values({ id: "n", name: "Namespace", isDefault: true });
  await source
    .insert(tables.partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await source
    .insert(tables.layerTable)
    .values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await source.insert(tables.scopeTable).values({ id: "s", name: "Scope" });
  await source.insert(tables.taskspaceTable).values({
    id: "t",
    namespaceId: "n",
    scopeId: "s",
    name: "Taskspace",
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
  });
  await source
    .insert(tables.taskspaceLocalTable)
    .values({ taskspaceId: "t", path: "source-device-only" });
  await source
    .insert(tables.inventoryTable)
    .values({ id: "i", namespaceId: "n", name: "Inventory" });
  await source.insert(tables.cardTable).values([
    {
      id: "stored",
      partitionId: "p",
      layerId: "l",
      inventoryId: "i",
      inventorySlot: 0,
      content: "Stored",
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
    },
    {
      id: "canvas",
      partitionId: "p",
      layerId: "l",
      taskspaceId: "t",
      content: "\ufeffText\0🪁",
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
    },
  ]);
  await source
    .update(tables.cardTable)
    .set({ createdAt: new Date(0), updatedAt: new Date(0) })
    .where(eq(tables.cardTable.id, "canvas"));
  await source.run(
    sql`UPDATE card SET pos_x=CAST('9007199254740993' AS INTEGER),width=1.5 WHERE id='canvas'`,
  );
  await source.insert(tables.glueTable).values({ id: "g" });
  await source.insert(tables.glueRelTable).values([
    { glueId: "g", cardId: "stored" },
    { glueId: "g", cardId: "canvas" },
  ]);
  await source.insert(tables.scopeRelTable).values({ scopeId: "s", cardId: "canvas" });
  await source
    .insert(tables.scopeAreaTable)
    .values({ id: "a", scopeId: "s", namespaceId: "n", posX: 0, posY: 0, width: 100, height: 100 });
  await source.insert(tables.warpTable).values({ id: "w", namespaceId: "n" });
  const rows = await captureApplicationRows(source);
  const input = {
    version: 1,
    rowEncodingVersion: 1,
    schemaId: migrations.at(-1)!.id,
    tables: capturedTables.map(({ name }) => ({
      name,
      rows: rows.filter(({ table }) => table === name).map(({ row }) => row),
    })),
  };
  const projection = parseSharedRecoveryProjection(input);
  const target = await database();
  const objects = await schema(target);
  const create = vi.fn(async () => target);
  const validate = (value: unknown = projection) => validateSharedRecoveryProjection(create, value);
  const unchanged = async () => {
    expect(await captureApplicationRows(source)).toEqual(rows);
    expect(await source.select().from(tables.taskspaceLocalTable)).toMatchObject([
      { path: "source-device-only" },
    ]);
    expect(await captureApplicationRows(target)).toEqual([]);
    expect(await target.select().from(tables.taskspaceLocalTable)).toEqual([]);
    expect(await schema(target)).toEqual(objects);
  };
  return { source, target, input, projection, objects, create, validate, unchanged };
}
function changed(input: SharedRecoveryProjection, table: string, id: string, patch: TaggedRow) {
  return {
    ...input,
    tables: input.tables.map((entry) => ({
      ...entry,
      rows: entry.rows.map((row) =>
        entry.name === table && row.id?.[1] === id ? { ...row, ...patch } : row,
      ),
    })),
  };
}

it("validates all shared tables exactly and restores temporary rows and business triggers before success", async () => {
  const f = await fixture();
  expect(f.projection.tables).toHaveLength(12);
  expect(f.projection.tables.every(({ rows }) => rows.length > 0)).toBe(true);
  expect(
    f.projection.tables
      .find(({ name }) => name === "card")!
      .rows.find((row) => row.id[1] === "canvas"),
  ).toMatchObject({
    pos_x: ["integer", "9007199254740993"],
    width: ["real", "3ff8000000000000"],
    content: ["text", "\ufeffText\0🪁"],
    created_at: ["integer", "0"],
    updated_at: ["integer", "0"],
  });
  const result = await f.validate();
  expect(result).toEqual(f.projection);
  expect(result).not.toBe(f.projection);
  expect(Object.isFrozen(result.tables[0].rows[0])).toBe(true);
  await f.unchanged();
  await f.validate();
  await f.unchanged();
});

it("validates an explicitly empty shared projection without installing local attachments", async () => {
  const f = await fixture();
  const input = {
    ...f.projection,
    tables: f.projection.tables.map(({ name }) => ({ name, rows: [] })),
  };
  expect(await f.validate(input)).toEqual(input);
  await f.unchanged();
});

it("preserves BLOB cells and the minimum signed 64-bit integer without driver coercion", async () => {
  const f = await fixture();
  const input = changed(f.projection, "card", "canvas", {
    content: ["blob", "00ff"],
    pos_y: ["integer", "-9223372036854775808"],
  });
  expect(await f.validate(input)).toEqual(parseSharedRecoveryProjection(input));
  await f.unchanged();
});

it("copies and canonicalizes table, row and column ordering while preserving tagged values", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.input));
  input.tables.reverse();
  for (const table of input.tables) {
    table.rows.reverse();
    table.rows = table.rows.map((row: TaggedRow) =>
      Object.fromEntries(Object.entries(row).reverse()),
    );
  }
  const parsed = parseSharedRecoveryProjection(input);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(f.projection));
  input.tables.length = 0;
  expect(parsed).toEqual(f.projection);
});

it.each([
  "version",
  "encoding",
  "schema",
  "missing-table",
  "duplicate-table",
  "local-table",
  "missing-column",
  "extra-column",
  "duplicate-key",
  "null-key",
  "malformed-real",
  "sparse-tables",
])("refuses %s transport before calling the database factory", async (change) => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.input));
  if (change === "version") input.version = 2;
  if (change === "encoding") input.rowEncodingVersion = 2;
  if (change === "schema") input.schemaId = "unknown";
  if (change === "missing-table") input.tables.pop();
  if (change === "duplicate-table") input.tables.push(input.tables[0]);
  if (change === "local-table") input.tables.push({ name: "taskspace_local", rows: [] });
  const card = input.tables.find((table: { name: string }) => table.name === "card");
  if (change === "missing-column") delete card.rows[0].content;
  if (change === "extra-column") card.rows[0].extra = ["null"];
  if (change === "duplicate-key") card.rows.push(card.rows[0]);
  if (change === "null-key") card.rows[0].id = ["null"];
  if (change === "malformed-real") card.rows[0].width = ["real", "7ff0000000000000"];
  if (change === "sparse-tables") delete input.tables[0];
  await expect(f.validate(input)).rejects.toThrow();
  expect(f.create).not.toHaveBeenCalled();
  await f.unchanged();
});

it("rejects accessors and serialization hooks without invoking them", async () => {
  const f = await fixture();
  const getter = vi.fn(() => f.input.tables);
  const input = { ...f.input };
  Object.defineProperty(input, "tables", { enumerable: true, get: getter });
  await expect(f.validate(input)).rejects.toThrow("plain data");
  expect(getter).not.toHaveBeenCalled();
  const serialize = vi.fn(() => f.input);
  await expect(f.validate({ ...f.input, toJSON: serialize })).rejects.toThrow();
  expect(serialize).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it.each([
  ["foreign key", "card", "canvas", { partition_id: ["text", "missing"] }],
  ["NOT NULL", "card", "canvas", { content: ["null"] }],
  ["CHECK", "scope", "s", { name: ["text", ""] }],
  [
    "unique inventory slot",
    "card",
    "canvas",
    { inventory_id: ["text", "i"], inventory_slot: ["integer", "0"] },
  ],
  ["inventory pair", "card", "canvas", { inventory_slot: ["integer", "1"] }],
] as const)(
  "refuses invalid final %s rows and restores the isolated database",
  async (_name, table, id, patch) => {
    const f = await fixture();
    await expect(f.validate(changed(f.projection, table, id, patch))).rejects.toThrow();
    await f.unchanged();
  },
);

it.each([
  ["real", "3ff0000000000000"],
  ["real", "8000000000000000"],
  ["text", "1"],
] as const)("refuses affinity changes to %s %s through exact read-back", async (type, value) => {
  const f = await fixture();
  await expect(
    f.validate(changed(f.projection, "card", "canvas", { pos_x: [type, value] })),
  ).rejects.toThrow("differs from projection");
  await f.unchanged();
});

it.each(["shared", "local"])(
  "preserves existing %s destination rows when refusing a populated factory database",
  async (kind) => {
    const f = await fixture();
    if (kind === "shared")
      await f.target.run(sql`INSERT INTO namespace(id,name) VALUES('existing','Keep')`);
    else
      await f.target.run(
        sql`INSERT INTO taskspace_local VALUES('absent','keep','workspace_relative',0)`,
      );
    const before = await f.target.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`);
    await expect(f.validate()).rejects.toThrow("empty database");
    expect(await schema(f.target)).toEqual(before);
    if (kind === "shared")
      expect((await f.target.values(sql`SELECT name FROM namespace`))[0][0]).toBe("Keep");
    else expect((await f.target.values(sql`SELECT path FROM taskspace_local`))[0][0]).toBe("keep");
  },
);

it("refuses unexpected destination triggers before loading", async () => {
  const f = await fixture();
  await f.target.run(
    sql`CREATE TRIGGER unexpected AFTER INSERT ON card BEGIN UPDATE card SET content='Changed'; END`,
  );
  const before = await schema(f.target);
  await expect(f.validate()).rejects.toThrow("canonical schema");
  expect(await captureApplicationRows(f.target)).toEqual([]);
  expect(await schema(f.target)).toEqual(before);
});

it.each(["rows", "connection-flags"])(
  "refuses changed %s during SQL validation",
  async (change) => {
    const f = await fixture();
    let modified = false;
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
                    if (!modified && (await tx.values(sql`SELECT 1 FROM card LIMIT 1`)).length) {
                      modified = true;
                      if (change === "rows")
                        await tx.run(sql`UPDATE card SET content='Changed during read-back'`);
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
      validateSharedRecoveryProjection(async () => wrapped, f.projection),
    ).rejects.toThrow(change === "rows" ? "differs from projection" : "recursive_triggers");
    expect(modified).toBe(true);
    await f.unchanged();
  },
);

it.each(["ROLLBACK TO shared_recovery_validation", "RELEASE shared_recovery_validation"])(
  "refuses success after %s fails",
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
      validateSharedRecoveryProjection(async () => wrapped, f.projection),
    ).rejects.toThrow("Validation cleanup failed");
    await f.unchanged();
    await f.validate();
  },
);

it("refuses success after an outer commit failure and restores rows and triggers", async () => {
  const f = await fixture();
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
    validateSharedRecoveryProjection(async () => wrapped, f.projection),
  ).rejects.toThrow();
  await f.unchanged();
  await f.validate();
});

it("owns the projection before awaiting its database factory", async () => {
  const f = await fixture();
  const input = JSON.parse(JSON.stringify(f.input));
  const result = await validateSharedRecoveryProjection(async () => {
    input.schemaId = "changed";
    input.tables.length = 0;
    return f.target;
  }, input);
  expect(result).toEqual(f.projection);
  await f.unchanged();
});

it("propagates factory failures without changing the source", async () => {
  const f = await fixture();
  await expect(
    validateSharedRecoveryProjection(async () => {
      throw new Error("Factory failed");
    }, f.projection),
  ).rejects.toThrow("Factory failed");
  await f.unchanged();
});
