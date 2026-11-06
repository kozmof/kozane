import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter, createServiceContext } from "@kozane/core/database";
import { applyMigrations, validateDatabaseSchema, schemaVersion } from "@kozane/core/migrations";
import { namespaces, cards, snapshot } from "@kozane/core/services";
import * as schema from "@kozane/core/schema";
const output = process.argv[2];
const path = join(output, "sample.db");
const sqlite = new DatabaseSync(path);
let sampleNamespaceId;
try {
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE");
  const handle = drizzle(
    async (sql, args, method) => {
      const statement = sqlite.prepare(sql);
      statement.setReturnArrays(true);
      const rows = statement.all(...args);
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema },
  );
  async function transaction(operation) {
    sqlite.exec("BEGIN IMMEDIATE");
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
    write: transaction,
    read: transaction,
    migrate: async (prepare) => {
      const plan = await prepare(handle);
      sqlite.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
      try {
        for (const statement of plan) {
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
    },
  });
  await applyMigrations(db);
  const context = createServiceContext();
  sampleNamespaceId = (
    await namespaces.create(db, context, { name: "Restoration harness fixture" })
  ).id;
  const initial = await snapshot.get(db, context, sampleNamespaceId);
  await cards.create(db, context, sampleNamespaceId, {
    partitionId: initial.snapshot.partitions[0].id,
    content: "Disposable packed-consumer fixture 日本語",
  });
  await validateDatabaseSchema(db);
  if (sqlite.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Fixture has foreign-key violations");
  if (sqlite.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("Fixture integrity failed");
} finally {
  sqlite.close();
}
const bytes = readFileSync(path);
writeFileSync(
  join(output, "fixture.json"),
  JSON.stringify({
    schemaVersion,
    sampleNamespaceId,
    sampleHash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  }),
);
