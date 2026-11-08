import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createClient } from "@libsql/client";
import { openDb, type OpenedDb } from "../../db/client.js";
import { fileDbUrl } from "../../lib/db-url.js";
import { createDatabaseAdapter } from "../../db/database.js";
import {
  applyMigrations,
  validateDatabaseMigrationHistory,
  validateDatabaseSchema,
  canonicalSchemaManifest,
  readSchemaManifest,
  compareSchemaManifests,
  normalizeSchemaSql,
  SchemaMismatchError,
} from "@kozane/core/migrations";
const opened: OpenedDb[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fresh() {
  const root = mkdtempSync(join(tmpdir(), "kozane-schema-"));
  roots.push(root);
  const item = await openDb(fileDbUrl(join(root, "db.sqlite")));
  opened.push(item);
  await applyMigrations(item.db);
  return item.db;
}
it("matches the generated manifest on libsql and freezes its nested records", async () => {
  const db = await fresh();
  expect(await validateDatabaseSchema(db)).toEqual({
    matches: true,
    missing: [],
    unexpected: [],
    altered: [],
  });
  expect(canonicalSchemaManifest.some((object) => object.name === "__drizzle_migrations")).toBe(
    true,
  );
  expect(Object.isFrozen(canonicalSchemaManifest)).toBe(true);
  for (const object of canonicalSchemaManifest) {
    expect(Object.isFrozen(object)).toBe(true);
    if (object.columns) for (const row of object.columns) expect(Object.isFrozen(row)).toBe(true);
  }
});
it.each([
  ["required index", "DROP INDEX scope_rel_card"],
  ["required trigger", "DROP TRIGGER card_stamp_missing_timestamps"],
  ["unexpected column", "ALTER TABLE card ADD COLUMN unrecognized text"],
  ["missing column", "ALTER TABLE card DROP COLUMN content"],
  ["missing table", "DROP TABLE inventory"],
  ["unexpected table", "CREATE TABLE unexpected_table(a text)"],
  ["unexpected view", "CREATE VIEW unexpected_view AS SELECT id FROM card"],
])("rejects changed %s with intact history and performs no repairs", async (_name, change) => {
  const db = await fresh();
  await db.run(sql.raw(change));
  expect((await validateDatabaseMigrationHistory(db, "complete")).complete).toBe(true);
  const before = await db.values(sql`SELECT * FROM sqlite_schema ORDER BY name`);
  const history = await db.values(sql`SELECT * FROM __drizzle_migrations ORDER BY created_at`);
  const writes = await db.values(sql`SELECT total_changes()`);
  await expect(validateDatabaseSchema(db)).rejects.toBeInstanceOf(SchemaMismatchError);
  expect(await db.values(sql`SELECT * FROM sqlite_schema ORDER BY name`)).toEqual(before);
  expect(await db.values(sql`SELECT * FROM __drizzle_migrations ORDER BY created_at`)).toEqual(
    history,
  );
  expect(await db.values(sql`SELECT total_changes()`)).toEqual(writes);
});
it.each([
  ["declared type", "CREATE TABLE x(a TEXT)", "CREATE TABLE x(a INTEGER)"],
  ["nullability", "CREATE TABLE x(a TEXT)", "CREATE TABLE x(a TEXT NOT NULL)"],
  [
    "default literal",
    "CREATE TABLE x(a TEXT DEFAULT 'a b')",
    "CREATE TABLE x(a TEXT DEFAULT 'ab')",
  ],
  [
    "primary key order",
    "CREATE TABLE x(a,b,PRIMARY KEY(a,b))",
    "CREATE TABLE x(a,b,PRIMARY KEY(b,a))",
  ],
  ["check expression", "CREATE TABLE x(a CHECK(a>0))", "CREATE TABLE x(a CHECK(a>=0))"],
  ["uniqueness", "CREATE TABLE x(a UNIQUE)", "CREATE TABLE x(a)"],
  [
    "foreign key action",
    "CREATE TABLE x(a REFERENCES y(id) ON DELETE CASCADE)",
    "CREATE TABLE x(a REFERENCES y(id) ON DELETE RESTRICT)",
  ],
  [
    "index order",
    "CREATE TABLE x(a,b);CREATE INDEX ix ON x(a,b)",
    "CREATE TABLE x(a,b);CREATE INDEX ix ON x(b,a)",
  ],
  [
    "index direction",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a ASC)",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a DESC)",
  ],
  [
    "partial predicate",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a) WHERE a>0",
    "CREATE TABLE x(a);CREATE INDEX ix ON x(a) WHERE a>=0",
  ],
  [
    "view expression",
    "CREATE TABLE x(a);CREATE VIEW v AS SELECT a+1 FROM x",
    "CREATE TABLE x(a);CREATE VIEW v AS SELECT a+2 FROM x",
  ],
  [
    "trigger behavior",
    "CREATE TABLE x(a);CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a=1;END",
    "CREATE TABLE x(a);CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET a=2;END",
  ],
])("compares %s behavior with disposable feature fixtures", async (_name, original, altered) => {
  const left = createClient({ url: ":memory:" }),
    right = createClient({ url: ":memory:" });
  try {
    await left.executeMultiple(original);
    await right.executeMultiple(altered);
    const inspect = (client: typeof left) =>
      readSchemaManifest(async (query) =>
        (await client.execute(query)).rows.map((row) => Array.from(row)),
      );
    const expected = await inspect(left),
      actual = await inspect(right);
    expect(compareSchemaManifests(actual, expected).matches).toBe(false);
    expect(compareSchemaManifests(expected, expected).matches).toBe(true);
  } finally {
    left.close();
    right.close();
  }
});
it("accepts formatting, escaped names, default spacing and SQLite-owned statistics", async () => {
  const clients = [createClient({ url: ":memory:" }), createClient({ url: ":memory:" })];
  try {
    await clients[0].executeMultiple(
      "CREATE TABLE \"a'b\"(a TEXT DEFAULT ('a b' || 'c') CHECK(length(a)>0)); CREATE INDEX ix ON \"a'b\"(a);",
    );
    await clients[1].executeMultiple(
      "CREATE /* comment */ TABLE \"a'b\" ( a TEXT DEFAULT ( 'a b' || 'c' ) CHECK ( length ( a ) > 0 ) ); CREATE INDEX ix ON \"a'b\" ( a ); ANALYZE;",
    );
    const manifests = await Promise.all(
      clients.map((client) =>
        readSchemaManifest(async (query) =>
          (await client.execute(query)).rows.map((row) => Array.from(row)),
        ),
      ),
    );
    expect(compareSchemaManifests(manifests[0], manifests[1]).matches).toBe(true);
    expect(normalizeSchemaSql("x != 'a b'")).not.toEqual(normalizeSchemaSql("x = 'ab'"));
  } finally {
    for (const client of clients) client.close();
  }
});

it("propagates read failures without labeling them as schema defects", async () => {
  const failure = new Error("connection lost");
  const db = createDatabaseAdapter(
    drizzle(async () => ({ rows: [] })),
    {
      write: async () => {
        throw failure;
      },
      read: async () => {
        throw failure;
      },
    },
  );
  await expect(validateDatabaseSchema(db)).rejects.toBe(failure);
});
