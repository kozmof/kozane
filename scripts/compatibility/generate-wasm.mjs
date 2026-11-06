import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createDatabaseAdapter, createServiceContext } from "@kozane/core/database";
import { applyMigrations, schemaVersion } from "@kozane/core/migrations";
import * as schema from "@kozane/core/schema";
import { namespaces, cards, scopes, snapshot } from "@kozane/core/services";
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
    await seed(db, engine);
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
const context = createServiceContext();
await database("empty", async (db, engine) =>
  retain(db, engine, "empty", [{ kind: "empty" }, { namespaceId: "absent-id", kind: "missing" }]),
);
await database("sole", async (db, engine) => {
  const ns = await namespaces.create(db, context, { name: "単一 namespace 😀" });
  const initial = await snapshot.get(db, context, ns.id);
  const partitionId = initial.snapshot.partitions[0].id;
  const card = await cards.create(db, context, ns.id, {
    partitionId,
    content: "Reload recovery 日本語 😀\n:corpus:unicode",
  });
  await cards.update(db, context, ns.id, card.id, { width: 240 });
  await cards.update(db, context, ns.id, card.id, { width: null });
  await cards.create(db, context, ns.id, { partitionId, content: "界".repeat(context.contentMax) });
  await retain(db, engine, "sole", [
    { kind: "selected" },
    { namespaceId: ns.id, kind: "selected" },
    { namespaceId: "absent-id", kind: "missing" },
  ]);
});
await database("multiple", async (db, engine) => {
  const a = await namespaces.create(db, context, { name: "Alpha" }),
    b = await namespaces.create(db, context, { name: "Beta 日本語" });
  const shared = await scopes.create(db, context, { name: "Shared across namespaces" });
  for (const ns of [a, b]) {
    const initial = await snapshot.get(db, context, ns.id);
    await cards.create(db, context, ns.id, {
      partitionId: initial.snapshot.partitions[0].id,
      scopeId: shared.id,
      content: `Cross-namespace ${ns.name}`,
    });
  }
  await retain(db, engine, "multiple", [
    { kind: "selection_required" },
    { namespaceId: a.id, kind: "selected" },
    { namespaceId: b.id, kind: "selected" },
    { namespaceId: "absent-id", kind: "missing" },
  ]);
  await namespaces.setDefault(db, context, b.id);
  await retain(db, engine, "default", [
    { kind: "selected" },
    { namespaceId: a.id, kind: "selected" },
  ]);
});
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
