import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter } from "@kozane/core/database";
import { applyMigrations, schemaVersion } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import { seedBoundaries } from "./seed-boundaries.mjs";
import { seedCorpus } from "./seed-corpus.mjs";
import { validateCandidate } from "./validation.ts";
import { summarizeView } from "./view-summary.ts";
const output = process.argv[2],
  producer = JSON.parse(readFileSync(process.argv[3], "utf8"));
const sqlite = await sqlite3InitModule(),
  fixtures = [];
async function database(name, seed) {
  const engine = new sqlite.oo1.DB(`/${name}.db`, "c");
  engine.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE");
  const handle = drizzle(
    async (sql, args, method) => {
      const rows = [];
      engine.exec({ sql, bind: args, rowMode: "array", resultRows: rows });
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema },
  );
  async function transaction(begin, operation) {
    engine.exec(begin);
    try {
      const result = await operation(handle);
      engine.exec("COMMIT");
      return result;
    } catch (error) {
      engine.exec("ROLLBACK");
      throw error;
    }
  }
  const db = createDatabaseAdapter(handle, {
    read: (operation) => transaction("BEGIN DEFERRED", operation),
    write: (operation) => transaction("BEGIN IMMEDIATE", operation),
    migrate: async (prepare) => {
      const plan = await prepare(handle);
      engine.exec("PRAGMA foreign_keys=OFF; BEGIN DEFERRED");
      try {
        for (const statement of plan) engine.exec({ sql: statement.sql, bind: statement.args });
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
    await applyMigrations(db);
    await seed(db, engine, async (sql, bind = []) => {
      const rows = [];
      engine.exec({ sql, bind, rowMode: "array", resultRows: rows });
      return rows;
    });
  } finally {
    engine.close();
  }
}
async function retain(db, engine, name, requests) {
  const expected = [];
  for (const request of requests) {
    const view = await validateCandidate(db, { namespaceId: request.namespaceId });
    assert.equal(view.kind, request.kind);
    expected.push({
      ...(request.namespaceId !== undefined ? { namespaceId: request.namespaceId } : {}),
      view: await summarizeView(view),
    });
  }
  const bytes = sqlite.capi.sqlite3_js_db_export(engine.pointer);
  assert.ok(bytes.byteLength <= 2_097_152);
  const file = `${name}.sqlite3`;
  writeFileSync(join(output, file), bytes, { flag: "wx" });
  fixtures.push({
    id: name,
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    expected,
  });
}
await (producer.scenarios === "boundaries" ? seedBoundaries : seedCorpus)(database, retain);
const wasm = JSON.parse(
  readFileSync(new URL(import.meta.resolve("@sqlite.org/sqlite-wasm/package.json")), "utf8"),
);
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      format: 1,
      migrationId: schemaVersion,
      producer: {
        ...producer,
        driver: {
          package: wasm.name,
          version: wasm.version,
          engine: sqlite.capi.sqlite3_libversion(),
          adapter: "drizzle/sqlite-proxy",
          runtime: process.version,
        },
      },
      fixtures,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(`Generated ${fixtures.length} retained wasm fixtures through packed public services.`);
