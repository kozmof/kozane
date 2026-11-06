import { afterEach, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createClient } from "@libsql/client";
import {
  migrations,
  applyMigrations,
  schemaVersion,
  validateMigrationHistory,
  MigrationHistoryError,
} from "../../../packages/core/src/migrations.js";
import { runMigrations, getMigrationStatus } from "./db.js";
import { openDb } from "../../db/client.js";
const rows = () => migrations.map((record) => ({ hash: record.hash, created_at: record.when }));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("preserves the original journal metadata, SQL, Drizzle hash and statement boundaries", () => {
  const journal = JSON.parse(readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"));
  const drizzle = readMigrationFiles({ migrationsFolder: "drizzle" });
  expect(migrations).toHaveLength(journal.entries.length);
  for (let index = 0; index < migrations.length; index++) {
    const record = migrations[index],
      entry = journal.entries[index],
      expected = drizzle[index];
    expect(record).toMatchObject({ ...entry, id: entry.tag });
    expect(record.sql).toBe(readFileSync(resolve("drizzle", `${entry.tag}.sql`), "utf8"));
    expect(record.hash).toBe(expected.hash);
    expect(record.statements).toEqual(expected.sql);
    expect(record.when).toBe(expected.folderMillis);
    expect(record.breakpoints).toBe(expected.bps);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.statements)).toBe(true);
    expect(Reflect.set(record, "sql", "changed")).toBe(false);
  }
  expect(Object.isFrozen(migrations)).toBe(true);
  expect(schemaVersion).toBe(journal.entries.at(-1).tag);
  expect(
    migrations
      .at(-1)!
      .statements.some(
        (statement) =>
          statement.includes("CREATE TRIGGER") &&
          statement.includes("BEGIN") &&
          statement.includes("END"),
      ),
  ).toBe(true);
});
it("accepts every contiguous prefix and freezes its result without changing input", () => {
  const complete = rows();
  for (let length = 0; length <= complete.length; length++) {
    const history = complete.slice(0, length);
    const original = structuredClone(history);
    const result = validateMigrationHistory(history, "prefix");
    expect(result.appliedCount).toBe(length);
    expect(result.complete).toBe(length === migrations.length);
    expect(result.pending).toEqual(migrations.slice(length));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pending)).toBe(true);
    expect(history).toEqual(original);
  }
});
it.each(["number", "bigint", "string"])(
  "accepts matching complete history with %s timestamps",
  (kind) => {
    const history = rows().map((row) => ({
      ...row,
      created_at:
        kind === "number"
          ? row.created_at
          : kind === "bigint"
            ? BigInt(row.created_at)
            : String(row.created_at),
    }));
    expect(validateMigrationHistory(history, "complete")).toEqual({
      appliedCount: migrations.length,
      complete: true,
      pending: [],
    });
  },
);
it.each([
  [[], "complete", "pending"],
  [rows().slice(0, -1), "complete", "pending"],
  [rows().slice(1), "prefix", "gap"],
  [[rows()[1], rows()[0]], "prefix", "gap"],
  [[rows()[0], rows()[0]], "prefix", "duplicate"],
  [[{ hash: rows()[0].hash, created_at: 1 }], "prefix", "unknown"],
  [[{ ...rows()[0], hash: "historical hash" }], "prefix", "mismatch"],
  [[...rows(), { hash: "extra", created_at: migrations.at(-1)!.when + 1 }], "complete", "unknown"],
  [null, "prefix", "invalid"],
  [[null], "prefix", "invalid"],
  [[{ hash: 42, created_at: rows()[0].created_at }], "prefix", "invalid"],
  [[{ hash: rows()[0].hash, created_at: NaN }], "prefix", "invalid"],
  [[{ hash: rows()[0].hash, created_at: "" }], "prefix", "invalid"],
  [[{ hash: rows()[0].hash, created_at: " 1781734555597" }], "prefix", "invalid"],
  [[{ hash: rows()[0].hash, created_at: 2n ** 63n }], "prefix", "invalid"],
] as const)("rejects invalid or incompatible history %#", (history, mode, reason) => {
  try {
    validateMigrationHistory(history, mode);
    throw new Error("History unexpectedly accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationHistoryError);
    expect(error).toMatchObject({ reason });
  }
});
it("requires an explicit supported history mode at runtime", () => {
  // @ts-expect-error A caller must choose prefix or complete.
  expect(() => validateMigrationHistory(rows(), "automatic")).toThrow(MigrationHistoryError);
  // @ts-expect-error A history mode cannot be omitted.
  expect(() => validateMigrationHistory(rows())).toThrow(MigrationHistoryError);
});
it.each(["hash", "duplicate", "unknown", "gap"] as const)(
  "retains Node compatibility for a historical %s case without rewriting records",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "kozane-core-history-"));
    roots.push(root);
    const url = `file:${join(root, "database.db")}`;
    await runMigrations(url);
    const client = createClient({ url });
    try {
      if (kind === "hash")
        await client.execute({
          sql: "UPDATE __drizzle_migrations SET hash = 'historical hash' WHERE created_at = ?",
          args: [migrations[0].when],
        });
      else if (kind === "duplicate")
        await client.execute({
          sql: "INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)",
          args: [migrations[0].hash, migrations[0].when],
        });
      else if (kind === "unknown")
        await client.execute({
          sql: "INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)",
          args: ["unknown", migrations.at(-1)!.when + 1],
        });
      else
        await client.execute({
          sql: "DELETE FROM __drizzle_migrations WHERE created_at = ?",
          args: [migrations[0].when],
        });
      const before = (
        await client.execute(
          "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at",
        )
      ).rows.map((row) => ({ id: row.id, hash: row.hash, created_at: row.created_at }));
      expect(() => validateMigrationHistory(before, "complete")).toThrow(MigrationHistoryError);
      const candidate = await openDb(url);
      try {
        await expect(applyMigrations(candidate.db)).rejects.toBeInstanceOf(MigrationHistoryError);
      } finally {
        candidate.close();
      }
      expect((await getMigrationStatus(url)).state).toBe(kind === "gap" ? "gapped" : "current");
      await runMigrations(url);
      const after = (
        await client.execute(
          "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at",
        )
      ).rows.map((row) => ({ id: row.id, hash: row.hash, created_at: row.created_at }));
      expect(after).toEqual(before);
    } finally {
      client.close();
    }
  },
);
