import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { openDb, type OpenedDb } from "../../db/client.js";
import { createDatabaseAdapter } from "../../db/database.js";
import { fileDbUrl } from "../../lib/db-url.js";
import {
  applyMigrations,
  validateDatabaseMigrationHistory,
  migrations,
  schemaVersion,
} from "@kozane/core/migrations";
const opened: OpenedDb[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fresh() {
  const root = mkdtempSync(join(tmpdir(), "kozane-public-migrations-"));
  roots.push(root);
  const item = await openDb(fileDbUrl(join(root, "db.sqlite")));
  opened.push(item);
  return item.db;
}
it("validates a missing table without creating it and applies all records exactly once", async () => {
  const db = await fresh();
  expect(await validateDatabaseMigrationHistory(db, "prefix")).toMatchObject({
    appliedCount: 0,
    complete: false,
  });
  await expect(validateDatabaseMigrationHistory(db, "complete")).rejects.toMatchObject({
    reason: "pending",
  });
  expect(
    await db.values(sql`SELECT name FROM sqlite_schema WHERE name = '__drizzle_migrations'`),
  ).toEqual([]);
  expect(await applyMigrations(db)).toEqual({
    schemaVersion,
    appliedIds: migrations.map((record) => record.id),
  });
  const before = await db.values(
    sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  expect(before).toEqual(
    migrations.map((record) => ({ hash: record.hash, created_at: record.when })),
  );
  expect(await applyMigrations(db)).toEqual({ schemaVersion, appliedIds: [] });
  expect(
    await db.values(sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at`),
  ).toEqual(before);
  expect(await validateDatabaseMigrationHistory(db, "complete")).toMatchObject({
    complete: true,
    pending: [],
  });
  expect(await db.values(sql`PRAGMA foreign_keys`)).toMatchObject([{ foreign_keys: 1 }]);
  expect(await db.values(sql`PRAGMA foreign_key_check`)).toEqual([]);
});
it("rejects a changed hash without repairing history or changing schema", async () => {
  const db = await fresh();
  await applyMigrations(db);
  await db.run(
    sql`UPDATE __drizzle_migrations SET hash = 'legacy' WHERE created_at = ${migrations[0].when}`,
  );
  const before = await db.values(sql`SELECT * FROM __drizzle_migrations`);
  const schema = await db.values(sql`SELECT * FROM sqlite_schema`);
  await expect(applyMigrations(db)).rejects.toMatchObject({ reason: "mismatch" });
  expect(await db.values(sql`SELECT * FROM __drizzle_migrations`)).toEqual(before);
  expect(await db.values(sql`SELECT * FROM sqlite_schema`)).toEqual(schema);
});
it("rolls back a late batch failure, restores foreign keys and allows an explicit retry", async () => {
  const db = await fresh();
  await db.run(
    sql`CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  await db.run(
    sql.raw(
      `CREATE TRIGGER reject_history BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at = ${migrations.at(-1)!.when} BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`,
    ),
  );
  await expect(applyMigrations(db)).rejects.toThrow("injected migration failure");
  expect(await db.values(sql`SELECT * FROM __drizzle_migrations`)).toEqual([]);
  expect(
    await db.values(
      sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name != '__drizzle_migrations'`,
    ),
  ).toEqual([]);
  expect(await db.values(sql`PRAGMA foreign_keys`)).toMatchObject([{ foreign_keys: 1 }]);
  await db.run(sql`DROP TRIGGER reject_history`);
  expect((await applyMigrations(db)).appliedIds).toHaveLength(migrations.length);
});
it("rejects an unsupported adapter before preparation", async () => {
  const run = vi.fn();
  const handle = drizzle(run);
  const db = createDatabaseAdapter(handle, {
    write: (operation) => operation(handle),
    read: (operation) => operation(handle),
  });
  await expect(applyMigrations(db)).rejects.toThrow("does not support migration batches");
  expect(run).not.toHaveBeenCalled();
});
it("upgrades a valid older prefix without rewriting existing history", async () => {
  const db = await fresh();
  await db.run(
    sql`CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  for (const record of migrations.slice(0, 2)) {
    for (const statement of record.statements) await db.run(sql.raw(statement));
    await db.run(
      sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (${record.hash}, ${record.when})`,
    );
  }
  const before = await db.values(sql`SELECT * FROM __drizzle_migrations ORDER BY created_at`);
  expect((await applyMigrations(db)).appliedIds).toEqual(
    migrations.slice(2).map((record) => record.id),
  );
  expect(
    (await db.values(sql`SELECT * FROM __drizzle_migrations ORDER BY created_at`)).slice(0, 2),
  ).toEqual(before);
  expect(await validateDatabaseMigrationHistory(db, "complete")).toMatchObject({ complete: true });
});

it("rejects invalid hooks and duplicate registration without replacing the adapter", async () => {
  const handle = drizzle(async () => ({ rows: [] }));
  const write = vi.fn();
  const read = vi.fn();
  expect(() => createDatabaseAdapter(handle, { write, read: undefined! })).toThrow(TypeError);
  const db = createDatabaseAdapter(handle, { write, read });
  expect(db).toBe(handle);
  expect(() => createDatabaseAdapter(handle, { write: vi.fn(), read: vi.fn() })).toThrow(
    "already has an adapter",
  );
});
