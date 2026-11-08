import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { sql } from "drizzle-orm";
import { createDatabaseAdapter, createServiceContext } from "@kozane/core/database";
import * as schema from "@kozane/core/schema";
import * as services from "@kozane/core/services";
import {
  applyMigrations,
  validateDatabaseMigrationHistory,
  MigrationHistoryError,
  migrations,
  schemaVersion,
} from "@kozane/core/migrations";

const historyDDL =
  "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)";
function adapter() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const state = { batches: 0, afterCommit: async () => {} };
  const handle = drizzle(
    async (text, args, method) => {
      const statement = sqlite.prepare(text);
      if (method === "run") {
        statement.run(...args);
        return { rows: [] };
      }
      statement.setReturnArrays(true);
      return { rows: method === "get" ? statement.get(...args) : statement.all(...args) };
    },
    { schema },
  );
  async function transaction(begin, operation) {
    sqlite.exec(begin);
    try {
      const result = await operation(handle);
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  const db = createDatabaseAdapter(handle, {
    write: (operation) => transaction("BEGIN IMMEDIATE", operation),
    read: (operation) => transaction("BEGIN DEFERRED", operation),
    migrate: async (prepare) => {
      assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      const plan = await prepare(handle);
      state.batches++;
      sqlite.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
      try {
        for (const statement of plan) {
          assert.ok(Object.isFrozen(statement));
          assert.ok(Object.isFrozen(statement.args));
          if (statement.args.length) sqlite.prepare(statement.sql).run(...statement.args);
          else sqlite.exec(statement.sql);
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        sqlite.exec("PRAGMA foreign_keys=ON");
      }
      await state.afterCommit();
    },
  });
  return { sqlite, db, state };
}
function history(sqlite) {
  return sqlite
    .prepare("SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at")
    .all();
}
function schemaRows(sqlite) {
  return sqlite
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
}
async function using(operation) {
  const instance = adapter();
  try {
    await operation(instance);
  } finally {
    instance.sqlite.close();
  }
}

const reference = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  await using(async ({ sqlite, db }) => {
    assert.equal((await validateDatabaseMigrationHistory(db, "prefix")).appliedCount, 0);
    await assert.rejects(
      validateDatabaseMigrationHistory(db, "complete"),
      (error) => error.reason === "pending",
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n, 0);
    assert.deepEqual(await applyMigrations(db), {
      schemaVersion,
      appliedIds: migrations.map((record) => record.id),
    });
    assert.deepEqual(history(sqlite), history(reference));
    // The history DDL has equivalent whitespace. Application objects must be identical.
    assert.deepEqual(
      schemaRows(sqlite).filter((row) => row.name !== "__drizzle_migrations"),
      schemaRows(reference).filter((row) => row.name !== "__drizzle_migrations"),
    );
    const before = history(sqlite);
    assert.deepEqual(await applyMigrations(db), { schemaVersion, appliedIds: [] });
    assert.deepEqual(history(sqlite), before);
    const context = createServiceContext();
    const namespace = await services.namespaces.create(db, context, { name: "Packed consumer" });
    const initial = await services.snapshot.get(db, context, namespace.id);
    const card = await services.cards.create(db, context, namespace.id, {
      partitionId: initial.snapshot.partitions[0].id,
      content: "Public migration consumer",
    });
    assert.equal(
      (await services.snapshot.get(db, context, namespace.id)).snapshot.cards[0].id,
      card.id,
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((await validateDatabaseMigrationHistory(db, "complete")).complete, true);
    assert.deepEqual(await db.values(sql`SELECT hash FROM __drizzle_migrations LIMIT 1`), [
      [migrations[0].hash],
    ]);
  });
  await using(async ({ sqlite, db }) => {
    sqlite.exec(historyDDL);
    for (const record of migrations.slice(0, 5)) {
      for (const statement of record.statements) sqlite.exec(statement);
      sqlite
        .prepare("INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)")
        .run(record.hash, record.when);
    }
    sqlite.exec(
      "INSERT INTO project(id,name) VALUES ('n','Upgrade'); INSERT INTO bundle(id,project_id,name) VALUES ('p','n','Main'); INSERT INTO card(id,bundle_id,content) VALUES ('c','p','Preserved'); INSERT INTO glue(id) VALUES ('g'); INSERT INTO glue_rel(glue_id,card_id) VALUES ('g','c'); INSERT INTO scope(id,name) VALUES ('s','Scope'); INSERT INTO scope_rel(scope_id,card_id) VALUES ('s','c')",
    );
    const before = history(sqlite);
    assert.deepEqual(
      (await applyMigrations(db)).appliedIds,
      migrations.slice(5).map((record) => record.id),
    );
    assert.deepEqual(history(sqlite).slice(0, 5), before);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM glue_rel WHERE card_id='c'").get().n, 1);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS n FROM scope_rel WHERE card_id='c'").get().n,
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT content FROM card WHERE id='c'").get().content,
      "Preserved",
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  });
  await using(async ({ sqlite, db, state }) => {
    sqlite.exec(historyDDL);
    sqlite.exec(
      `CREATE TRIGGER reject_history BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at = ${migrations.at(-1).when} BEGIN SELECT RAISE(ABORT, 'late failure'); END`,
    );
    const before = schemaRows(sqlite);
    await assert.rejects(applyMigrations(db), /late failure/);
    assert.equal(state.batches, 1);
    assert.deepEqual(history(sqlite), []);
    assert.deepEqual(schemaRows(sqlite), before);
    assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    sqlite.exec("DROP TRIGGER reject_history");
    await applyMigrations(db);
    sqlite
      .prepare("UPDATE __drizzle_migrations SET hash='altered' WHERE created_at=?")
      .run(migrations[0].when);
    const altered = history(sqlite);
    const batches = state.batches;
    await assert.rejects(
      applyMigrations(db),
      (error) => error instanceof MigrationHistoryError && error.reason === "mismatch",
    );
    assert.equal(state.batches, batches);
    assert.deepEqual(history(sqlite), altered);
  });
  for (const defect of ["empty", "prefix", "duplicate", "gap", "unknown", "timestamp", "hash"]) {
    await using(async ({ sqlite, db, state }) => {
      await applyMigrations(db);
      if (defect === "empty") sqlite.exec("DELETE FROM __drizzle_migrations");
      else if (defect === "prefix")
        sqlite
          .prepare("DELETE FROM __drizzle_migrations WHERE created_at=?")
          .run(migrations.at(-1).when);
      else if (defect === "duplicate")
        sqlite
          .prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)")
          .run(migrations[0].hash, migrations[0].when);
      else if (defect === "gap")
        sqlite
          .prepare("DELETE FROM __drizzle_migrations WHERE created_at=?")
          .run(migrations[0].when);
      else if (defect === "unknown")
        sqlite
          .prepare("INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)")
          .run("unknown", migrations.at(-1).when + 1);
      else if (defect === "timestamp")
        sqlite
          .prepare("UPDATE __drizzle_migrations SET created_at=1 WHERE created_at=?")
          .run(migrations[0].when);
      else
        sqlite
          .prepare("UPDATE __drizzle_migrations SET hash='altered' WHERE created_at=?")
          .run(migrations[0].when);
      const before = history(sqlite),
        beforeSchema = schemaRows(sqlite);
      const changes = sqlite.prepare("SELECT total_changes() AS n").get().n;
      await assert.rejects(validateDatabaseMigrationHistory(db, "complete"), MigrationHistoryError);
      assert.deepEqual(history(sqlite), before);
      assert.deepEqual(schemaRows(sqlite), beforeSchema);
      assert.equal(sqlite.prepare("SELECT total_changes() AS n").get().n, changes);
      if (defect === "empty" || defect === "prefix") {
        assert.equal((await validateDatabaseMigrationHistory(db, "prefix")).complete, false);
      } else {
        await assert.rejects(applyMigrations(db), MigrationHistoryError);
        assert.equal(state.batches, 1);
        assert.deepEqual(history(sqlite), before);
      }
    });
  }
  await using(async ({ db, state }) => {
    state.afterCommit = async () => {
      throw new Error("commit reply lost");
    };
    await assert.rejects(applyMigrations(db), /commit reply lost/);
    assert.equal(state.batches, 1);
    assert.equal((await validateDatabaseMigrationHistory(db, "complete")).complete, true);
    state.afterCommit = async () => {};
    assert.deepEqual((await applyMigrations(db)).appliedIds, []);
  });
  await using(async ({ db, state }) => {
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let committed;
    const reachedCommit = new Promise((resolve) => {
      committed = resolve;
    });
    state.afterCommit = async () => {
      committed();
      await blocked;
    };
    let settled = false;
    const applying = applyMigrations(db).then((result) => {
      settled = true;
      return result;
    });
    await reachedCommit;
    assert.equal(settled, false);
    release();
    assert.equal((await applying).schemaVersion, schemaVersion);
    assert.equal(state.batches, 1);
  });
} finally {
  reference.close();
}
console.log(
  "Packed migration application, legacy parity, upgrades, rollback and commit boundaries passed.",
);
