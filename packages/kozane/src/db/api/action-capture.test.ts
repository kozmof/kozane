import { expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { withTx, type DB, type Tx } from "@kozane/core/database";
import {
  captureRowSql,
  decodeCapturedRow,
  installationInsert,
  type InstallationValue,
} from "../../../../core/src/actions/sql-codec.js";
import {
  encodeStorageValue,
  type TaggedRow,
  type StorageValue,
} from "../../../../core/src/actions/row-codec.js";
import {
  createRowProjection,
  type ProjectionEffect,
} from "../../../../core/src/actions/projection.js";

// Fixture identifiers contain no question marks. Production integration will use driver bindings.
function statement(value: InstallationValue): SQL {
  const parts = value.sql.split("?");
  expect(parts.length).toBe(value.args.length + 1);
  return sql.join(
    parts.flatMap((part, index) =>
      index === 0 ? [sql.raw(part)] : [sql`${value.args[index - 1]}`, sql.raw(part)],
    ),
    sql``,
  );
}
const tables = [
  { name: "probe_parent", columns: ["id"], primaryKey: ["id"] },
  { name: "probe_row", columns: ["id", "parent_id", "value"], primaryKey: ["id"] },
];
async function query(db: DB | Tx, text: SQL): Promise<unknown[][]> {
  const result = await db.values(text);
  return result.map((row) => (Array.isArray(row) ? row : Object.values(row)));
}
async function capture(
  db: DB | Tx,
  name: string,
  columns: readonly string[],
): Promise<TaggedRow[]> {
  const result = await query(
    db,
    sql.raw(`SELECT ${captureRowSql(columns)} FROM "${name}" ORDER BY id`),
  );
  return result.map(([json]) => decodeCapturedRow(json as string));
}
async function effects(db: DB | Tx): Promise<ProjectionEffect[]> {
  const result = await query(
    db,
    sql`SELECT ord,tbl,op,row_key,before_image,after_image FROM probe_effect ORDER BY ord`,
  );
  return result.map(([ord, table, op, key, before, after]) => ({
    ord: Number(ord),
    table: table as string,
    op: op as "I" | "U" | "D",
    key: decodeCapturedRow(key as string),
    before: before === null ? null : decodeCapturedRow(before as string),
    after: after === null ? null : decodeCapturedRow(after as string),
  }));
}
async function setup(reverse = false) {
  const db = await createTestDB();
  await db.run(sql`PRAGMA foreign_keys=ON`);
  await db.run(sql`PRAGMA recursive_triggers=ON`);
  expect(Number((await query(db, sql`PRAGMA foreign_keys`))[0][0])).toBe(1);
  expect(Number((await query(db, sql`PRAGMA recursive_triggers`))[0][0])).toBe(1);
  await db.run(sql`CREATE TABLE probe_parent (id TEXT PRIMARY KEY NOT NULL)`);
  await db.run(
    sql`CREATE TABLE probe_row (id TEXT PRIMARY KEY NOT NULL,parent_id TEXT REFERENCES probe_parent(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,value)`,
  );
  await db.run(
    sql`CREATE TABLE probe_context (singleton INTEGER PRIMARY KEY CHECK(singleton=1),action_id TEXT,next_ord INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'record')`,
  );
  await db.run(sql`INSERT INTO probe_context(singleton) VALUES(1)`);
  await db.run(
    sql`CREATE TABLE probe_effect (ord INTEGER PRIMARY KEY,tbl TEXT NOT NULL,op TEXT NOT NULL,row_key TEXT NOT NULL,before_image TEXT,after_image TEXT)`,
  );
  const installCapture = async () => {
    for (const table of tables) {
      for (const [op, event] of [
        ["I", "INSERT"],
        ["U", "UPDATE"],
        ["D", "DELETE"],
      ] as const) {
        const source = op === "D" ? "OLD" : "NEW";
        const before = op === "I" ? "NULL" : captureRowSql(table.columns, "OLD");
        const after = op === "D" ? "NULL" : captureRowSql(table.columns, "NEW");
        await db.run(
          sql.raw(`CREATE TRIGGER capture_${table.name}_${op} BEFORE ${event} ON ${table.name}
          WHEN (SELECT mode FROM probe_context)='record' BEGIN
          SELECT CASE WHEN (SELECT action_id FROM probe_context) IS NULL THEN RAISE(ABORT,'unstamped prototype write') END;
          ${op === "U" ? "SELECT CASE WHEN OLD.id IS NOT NEW.id THEN RAISE(ABORT,'primary key changed') END;" : ""}
          INSERT INTO probe_effect SELECT next_ord,'${table.name}','${op}',${captureRowSql(table.primaryKey, source)},${before},${after} FROM probe_context;
          UPDATE probe_context SET next_ord=next_ord+1;
        END`),
        );
      }
    }
  };
  const installBusiness = async () => {
    await db.run(sql`CREATE TRIGGER parent_child AFTER INSERT ON probe_parent WHEN NEW.id='auto' AND (SELECT mode FROM probe_context)='record'
      BEGIN INSERT INTO probe_row VALUES('auto-child',NEW.id,1); END`);
    await db.run(sql`CREATE TRIGGER row_add AFTER INSERT ON probe_row WHEN NEW.id='auto-child' AND (SELECT mode FROM probe_context)='record'
      BEGIN UPDATE probe_row SET value=value+1 WHERE id=NEW.id; END`);
    await db.run(sql`CREATE TRIGGER row_multiply AFTER INSERT ON probe_row WHEN NEW.id='auto-child' AND (SELECT mode FROM probe_context)='record'
      BEGIN UPDATE probe_row SET value=value*3 WHERE id=NEW.id; END`);
  };
  if (reverse) {
    await installBusiness();
    await installCapture();
  } else {
    await installCapture();
    await installBusiness();
  }
  return db;
}
async function root<T>(db: DB, operation: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.run(sql`PRAGMA recursive_triggers=ON`);
    expect(Number((await query(tx, sql`PRAGMA foreign_keys`))[0][0])).toBe(1);
    expect(Number((await query(tx, sql`PRAGMA recursive_triggers`))[0][0])).toBe(1);
    const [[marker, start]] = await query(tx, sql`SELECT action_id,next_ord FROM probe_context`);
    expect(marker).toBeNull();
    await tx.run(sql`UPDATE probe_context SET action_id='root'`);
    const value = await operation(tx);
    // Finalize and validate all provisional images before the transaction can commit.
    for (const effect of await effects(tx)) {
      if (effect.ord < Number(start)) continue;
      await tx.run(sql`UPDATE probe_effect SET row_key=${JSON.stringify(effect.key)},
        before_image=${effect.before === null ? null : JSON.stringify(effect.before)},
        after_image=${effect.after === null ? null : JSON.stringify(effect.after)} WHERE ord=${effect.ord}`);
    }
    await tx.run(sql`UPDATE probe_context SET action_id=NULL`);
    return value;
  });
}

it("captures and installs full storage classes without driver coercion", async () => {
  const db = await setup();
  const values: StorageValue[] = [
    { type: "null", value: null },
    ...[-(1n << 63n), (1n << 63n) - 1n, 9007199254740993n, -9007199254740993n, 0n].map((value) => ({
      type: "integer" as const,
      value,
    })),
    ...[
      0,
      -0,
      1,
      -1.5,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      2 ** -1022,
      2 ** -1022 - Number.MIN_VALUE,
      1 + Number.EPSILON,
      Math.PI,
    ].map((value) => ({ type: "real" as const, value })),
    ...["", "a\u0000b", "日本語 🪁", "\ufefftext", "e\u0301"].map((value) => ({
      type: "text" as const,
      value,
    })),
    { type: "blob", value: new Uint8Array() },
    { type: "blob", value: new Uint8Array([0, 255, 128]) },
  ];
  // Exercise mantissas throughout the finite exponent range, independently of the SQL encoder.
  let seed = 0x123456789abcdefn;
  for (let index = 0; index < 256; index++) {
    seed = BigInt.asUintN(64, seed * 6364136223846793005n + 1n);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, seed, false);
    const value = new DataView(bytes.buffer).getFloat64(0, false);
    if (Number.isFinite(value)) values.push({ type: "real", value });
  }
  const expected = values.map(
    (value, index): TaggedRow => ({
      id: ["text", String(index).padStart(3, "0")],
      parent_id: ["null"],
      value: encodeStorageValue(value),
    }),
  );
  await root(db, async (tx) => {
    for (const row of expected) await tx.run(statement(installationInsert("probe_row", row)));
  });
  const captured = await capture(db, "probe_row", tables[1].columns);
  expect(captured.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index++)
    expect(captured[index]).toEqual(expected[index]);
  const recorded = await effects(db);
  expect(recorded.length).toBe(expected.length);
  const projection = createRowProjection(tables, []).apply(recorded);
  expect(projection.rows("probe_row")).toEqual(expected);
  await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE probe_context SET mode='restore'`);
    await tx.run(sql`DELETE FROM probe_row`);
    for (const row of projection.rows("probe_row"))
      await tx.run(statement(installationInsert("probe_row", row)));
    projection.verifyInstalledRows("probe_row", await capture(tx, "probe_row", tables[1].columns));
    await tx.run(sql`UPDATE probe_context SET mode='record'`);
  });
  expect(await effects(db)).toEqual(recorded);
});

it.each([false, true])(
  "orders BEFORE effects across nested business triggers and FK cascades (reverse=%s)",
  async (reverse) => {
    const db = await setup(reverse);
    await root(db, async (tx) => {
      await tx.run(sql`INSERT INTO probe_parent VALUES('auto')`);
      await tx.run(sql`UPDATE probe_row SET value=value+10 WHERE id='auto-child'`);
    });
    const baseline = createRowProjection(tables, []);
    const first = await effects(db);
    expect(first.map((effect) => [effect.table, effect.op])).toEqual([
      ["probe_parent", "I"],
      ["probe_row", "I"],
      ["probe_row", "U"],
      ["probe_row", "U"],
      ["probe_row", "U"],
    ]);
    const materialized = baseline.apply(first);
    expect(materialized.rows("probe_row")).toEqual(
      await capture(db, "probe_row", tables[1].columns),
    );
    await withTx(db, async (tx) => {
      await tx.run(sql`UPDATE probe_context SET mode='restore'`);
      await tx.run(sql`DELETE FROM probe_row`);
      await tx.run(sql`DELETE FROM probe_parent`);
      for (const table of tables) {
        for (const image of materialized.rows(table.name))
          await tx.run(statement(installationInsert(table.name, image)));
        materialized.verifyInstalledRows(table.name, await capture(tx, table.name, table.columns));
      }
      await tx.run(sql`UPDATE probe_context SET mode='record'`);
    });
    expect(await effects(db)).toEqual(first);
    await root(db, (tx) => tx.run(sql`DELETE FROM probe_parent WHERE id='auto'`));
    const all = await effects(db);
    expect(all.slice(first.length).map((effect) => [effect.table, effect.op])).toEqual([
      ["probe_parent", "D"],
      ["probe_row", "D"],
    ]);
    expect(baseline.apply(all).rows("probe_row")).toEqual([]);
    expect(baseline.apply(all).rows("probe_parent")).toEqual([]);
    expect(materialized.rows("probe_row")).toHaveLength(1);
    const corrupted = all.map((effect) => ({ ...effect }));
    corrupted[2].before = { ...corrupted[2].before!, value: ["text", "wrong storage class"] };
    expect(() => baseline.apply(corrupted)).toThrow("Before image mismatch");
    expect(() => baseline.apply([all[1], all[0]])).toThrow();
    expect(await capture(db, "probe_row", tables[1].columns)).toEqual([]);
  },
);

it("rejects unstamped writes, primary-key changes and unsupported values with clean rollback", async () => {
  const db = await setup();
  await expect(db.run(sql`INSERT INTO probe_row VALUES('raw',NULL,1)`)).rejects.toThrow();
  await root(db, (tx) => tx.run(sql`INSERT INTO probe_row VALUES('kept',NULL,1)`));
  const original = await effects(db);
  await expect(
    root(db, (tx) =>
      tx.run(sql`INSERT INTO probe_row VALUES('deferred-failure','absent-parent',1)`),
    ),
  ).rejects.toThrow();
  await expect(
    root(db, async (tx) => {
      await tx.run(sql`UPDATE probe_row SET value=2 WHERE id='kept'`);
      await tx.run(sql`UPDATE probe_row SET id='changed' WHERE id='kept'`);
    }),
  ).rejects.toThrow();
  for (const value of [sql`CAST(X'80' AS TEXT)`, sql`CAST('1e999' AS REAL)`]) {
    await expect(
      root(db, (tx) => tx.run(sql`INSERT INTO probe_row VALUES('unsupported',NULL,${value})`)),
    ).rejects.toThrow();
  }
  expect(await effects(db)).toEqual(original);
  expect(await query(db, sql`SELECT id,value FROM probe_row`)).toEqual([["kept", 1]]);
  expect(await query(db, sql`SELECT action_id,mode FROM probe_context`)).toEqual([
    [null, "record"],
  ]);
  await expect(db.run(sql`UPDATE probe_row SET value=3`)).rejects.toThrow();
});

it.each([
  { affinity: "INTEGER", value: ["real", "3ff0000000000000"] },
  { affinity: "REAL", value: ["real", "8000000000000000"] },
] as const)(
  "refuses activation when $affinity affinity changes storage class or REAL bits",
  async ({ affinity, value }) => {
    const db = await setup();
    await db.run(sql.raw(`CREATE TABLE probe_affinity(id TEXT PRIMARY KEY,value ${affinity})`));
    await db.run(sql`INSERT INTO probe_affinity VALUES('old',7)`);
    const before = await capture(db, "probe_affinity", ["id", "value"]);
    const projected: TaggedRow = { id: ["text", "new"], value };
    const target = createRowProjection(
      [{ name: "probe_affinity", columns: ["id", "value"], primaryKey: ["id"] }],
      [{ table: "probe_affinity", row: projected }],
    );
    await expect(
      withTx(db, async (tx) => {
        await tx.run(sql`DELETE FROM probe_affinity`);
        await tx.run(statement(installationInsert("probe_affinity", projected)));
        target.verifyInstalledRows(
          "probe_affinity",
          await capture(tx, "probe_affinity", ["id", "value"]),
        );
      }),
    ).rejects.toThrow("Installed row differs from projection");
    expect(await capture(db, "probe_affinity", ["id", "value"])).toEqual(before);
  },
);

it("captures REAL columns whose names overlap SQL helper aliases", async () => {
  const db = await setup();
  await db.run(sql`CREATE TABLE probe_names(id TEXT PRIMARY KEY,x,e,s,"quote""'")`);
  const expected: TaggedRow = {
    id: ["text", "names"],
    x: encodeStorageValue({ type: "real", value: -Number.MIN_VALUE }),
    e: encodeStorageValue({ type: "real", value: -Math.PI }),
    s: encodeStorageValue({ type: "real", value: -0 }),
    "quote\"'": ["text", "escaped identifier"],
  };
  await db.run(statement(installationInsert("probe_names", expected)));
  expect(await capture(db, "probe_names", Object.keys(expected))).toEqual([expected]);
});
