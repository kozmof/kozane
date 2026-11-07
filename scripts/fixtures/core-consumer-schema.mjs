import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter } from "@kozane/core/database";
import { SchemaMismatchError as RootSchemaMismatchError } from "@kozane/core";
import {
  applyMigrations,
  validateDatabaseMigrationHistory,
  validateDatabaseSchema,
  readSchemaManifest,
  compareSchemaManifests,
  canonicalSchemaManifest,
  SchemaMismatchError,
} from "@kozane/core/migrations";
assert.equal(SchemaMismatchError, RootSchemaMismatchError);
assert.ok(Object.isFrozen(canonicalSchemaManifest));
const wasm = await sqlite3InitModule();
for (const engine of ["native", "wasm"]) {
  const sqlite =
    engine === "native" ? new DatabaseSync(":memory:") : new wasm.oo1.DB(":memory:", "c");
  function query(sql, args = []) {
    if (engine === "wasm") {
      const rows = [];
      sqlite.exec({ sql, bind: args, rowMode: "array", resultRows: rows });
      return rows;
    }
    const statement = sqlite.prepare(sql);
    statement.setReturnArrays(true);
    return statement.all(...args);
  }
  const execute = (sql, args = []) => {
    if (args.length) query(sql, args);
    else sqlite.exec(sql);
  };
  const handle = drizzle(async (sql, args, method) => {
    const rows = query(sql, args);
    return { rows: method === "get" ? rows[0] : rows };
  });
  async function transaction(operation) {
    execute("BEGIN DEFERRED");
    try {
      const value = await operation(handle);
      execute("COMMIT");
      return value;
    } catch (error) {
      execute("ROLLBACK");
      throw error;
    }
  }
  const db = createDatabaseAdapter(handle, {
    write: transaction,
    read: transaction,
    migrate: async (prepare) => {
      const plan = await prepare(handle);
      execute("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
      try {
        for (const statement of plan) execute(statement.sql, statement.args);
        execute("COMMIT");
      } catch (error) {
        execute("ROLLBACK");
        throw error;
      } finally {
        execute("PRAGMA foreign_keys=ON");
      }
    },
  });
  try {
    execute("PRAGMA foreign_keys=ON");
    await applyMigrations(db);
    assert.equal((await validateDatabaseSchema(db)).matches, true, engine);
    execute("ANALYZE");
    assert.equal((await validateDatabaseSchema(db)).matches, true, engine);
    for (const [alter, restore] of [
      ["DROP INDEX scope_rel_card", "CREATE INDEX scope_rel_card ON scope_rel(card_id)"],
      [
        "ALTER TABLE card ADD COLUMN unexpected_column text",
        "ALTER TABLE card DROP COLUMN unexpected_column",
      ],
      ["CREATE TABLE unexpected_table(a)", "DROP TABLE unexpected_table"],
      ["CREATE VIEW unexpected_view AS SELECT id FROM card", "DROP VIEW unexpected_view"],
    ]) {
      // Restore from the original definition so identifier quoting stays unchanged.
      const originalIndex = query(
        "SELECT sql FROM sqlite_schema WHERE name='scope_rel_card'",
      )[0]?.[0];
      execute(alter);
      assert.equal((await validateDatabaseMigrationHistory(db, "complete")).complete, true);
      assert.deepEqual(query("PRAGMA integrity_check"), [["ok"]]);
      assert.deepEqual(query("PRAGMA foreign_key_check"), []);
      const before = await readSchemaManifest(async (sql) => query(sql));
      const changes = query("SELECT total_changes()");
      await assert.rejects(
        validateDatabaseSchema(db),
        (error) => error instanceof SchemaMismatchError && error.reason === "schema_mismatch",
        engine,
      );
      assert.deepEqual(await readSchemaManifest(async (sql) => query(sql)), before);
      assert.deepEqual(query("SELECT total_changes()"), changes);
      execute(alter.startsWith("DROP INDEX") ? originalIndex : restore);
      assert.equal((await validateDatabaseSchema(db)).matches, true);
    }
    const trigger = query(
      "SELECT sql FROM sqlite_schema WHERE name='card_stamp_missing_timestamps'",
    )[0][0];
    execute("DROP TRIGGER card_stamp_missing_timestamps");
    await assert.rejects(validateDatabaseSchema(db), SchemaMismatchError);
    execute(trigger);
    assert.equal((await validateDatabaseSchema(db)).matches, true);
    execute("ALTER TABLE card DROP COLUMN content");
    assert.deepEqual(query("PRAGMA integrity_check"), [["ok"]]);
    assert.deepEqual(query("PRAGMA foreign_key_check"), []);
    await assert.rejects(validateDatabaseSchema(db), SchemaMismatchError);
    execute("ALTER TABLE card ADD COLUMN content text NOT NULL DEFAULT ''");
    await assert.rejects(validateDatabaseSchema(db), SchemaMismatchError);
    // Disposable fixtures cover views, constraints, default expressions and quoted identifiers.
    execute(
      "CREATE TABLE \"x'y\"(a TEXT DEFAULT ('a b' || 'c') CHECK(length(a)>0), b INTEGER, UNIQUE(a,b)); CREATE INDEX fixture_ix ON \"x'y\"(a DESC,b) WHERE b>0; CREATE VIEW fixture_v AS SELECT a FROM \"x'y\"",
    );
    const original = await readSchemaManifest(async (sql) => query(sql));
    execute('DROP VIEW fixture_v; DROP INDEX fixture_ix; DROP TABLE "x\'y"');
    execute(
      "CREATE /* formatting */ TABLE \"x'y\" ( a TEXT DEFAULT ( 'a b' || 'c' ) CHECK ( length ( a ) > 0 ), b INTEGER, UNIQUE ( a, b ) ); CREATE INDEX fixture_ix ON \"x'y\" ( a DESC, b ) WHERE b > 0; CREATE VIEW fixture_v AS SELECT a FROM \"x'y\"",
    );
    assert.equal(
      compareSchemaManifests(await readSchemaManifest(async (sql) => query(sql)), original).matches,
      true,
    );
    execute("DROP VIEW fixture_v; CREATE VIEW fixture_v AS SELECT a || 'changed' FROM \"x'y\"");
    assert.equal(
      compareSchemaManifests(await readSchemaManifest(async (sql) => query(sql)), original).matches,
      false,
    );
  } finally {
    sqlite.close();
  }
}
console.log(
  "Packed native and wasm schema parity, defect rejection, formatting and read-only checks passed.",
);
