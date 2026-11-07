import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle as libsqlDrizzle } from "drizzle-orm/libsql";
import { drizzle as proxyDrizzle } from "drizzle-orm/sqlite-proxy";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createDatabaseAdapter, createServiceContext, withTx } from "@kozane/core/database";
import {
  applyMigrations,
  validateDatabaseSchema,
  validateDatabaseMigrationHistory,
} from "@kozane/core/migrations";
import { namespaces, cards, snapshot } from "@kozane/core/services";
import * as schema from "@kozane/core/schema";

const wasm = await sqlite3InitModule();
for (const driver of ["libsql", "wasm"]) {
  const engine =
    driver === "libsql"
      ? createClient({ url: pathToFileURL(resolve("public-driver.sqlite3")).href })
      : new wasm.oo1.DB(":memory:", "c");
  let handle;
  async function query(sql, args = []) {
    const rows = [];
    engine.exec({ sql, bind: args, rowMode: "array", resultRows: rows });
    return rows;
  }
  async function transaction(mode, operation) {
    if (driver === "libsql") {
      const tx = await engine.transaction(mode);
      try {
        const value = await operation(libsqlDrizzle(tx, { schema }));
        await tx.commit();
        return value;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    }
    engine.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
    try {
      const value = await operation(handle);
      engine.exec("COMMIT");
      return value;
    } catch (error) {
      engine.exec("ROLLBACK");
      throw error;
    }
  }
  handle =
    driver === "libsql"
      ? libsqlDrizzle(engine, { schema })
      : proxyDrizzle(
          async (sql, args, method) => {
            const rows = await query(sql, args);
            return { rows: method === "get" ? rows[0] : rows };
          },
          { schema },
        );
  const db = createDatabaseAdapter(handle, {
    read: (operation) => transaction("read", operation),
    write: (operation) => transaction("write", operation),
    migrate: async (prepare) => {
      const plan = await prepare(handle);
      if (driver === "libsql") {
        await engine.migrate(plan.map(({ sql, args }) => ({ sql, args: [...args] })));
        return;
      }
      engine.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
      try {
        for (const { sql, args } of plan) await query(sql, args);
        engine.exec("COMMIT");
      } catch (error) {
        engine.exec("ROLLBACK");
        throw error;
      } finally {
        engine.exec("PRAGMA foreign_keys=ON");
      }
    },
  });
  try {
    if (driver === "libsql") await engine.execute("PRAGMA foreign_keys=ON");
    else engine.exec("PRAGMA foreign_keys=ON");
    await applyMigrations(db);
    await validateDatabaseMigrationHistory(db, "complete");
    assert.equal((await validateDatabaseSchema(db)).matches, true);
    const context = createServiceContext();
    const ns = await namespaces.create(db, context, { name: `Packed ${driver}` });
    const initial = await snapshot.get(db, context, ns.id);
    const partitionId = initial.snapshot.partitions[0].id;
    const card = await cards.create(db, context, ns.id, {
      partitionId,
      content: "Public driver 日本語",
    });
    await cards.update(db, context, ns.id, card.id, { width: 240 });
    await cards.update(db, context, ns.id, card.id, { width: null });
    const failure = new Error("intentional rollback");
    await assert.rejects(
      withTx(db, async (tx) => {
        await cards.createInTx(tx, context, ns.id, { partitionId, content: "Must roll back" });
        throw failure;
      }),
      (error) => error === failure,
    );
    const result = await snapshot.get(db, context, ns.id);
    assert.equal(result.snapshot.cards.length, 1);
    assert.equal(result.snapshot.cards[0].content, "Public driver 日本語");
    assert.equal(result.snapshot.cards[0].width, null);
    assert.equal(await snapshot.get(db, context, "00000000-0000-4000-8000-000000000000"), null);
    await cards.removeOne(db, context, ns.id, card.id);
    assert.equal((await snapshot.get(db, context, ns.id)).snapshot.cards.length, 0);
  } finally {
    engine.close();
  }
}
console.log(
  "Packed public libsql and wasm adapters passed migrations, services, nullable updates, missing reads and rollback checks.",
);
