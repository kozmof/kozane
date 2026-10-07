import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { brandDb, type AnyDB, type DB } from "../db/tx.js";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { onTestFinished } from "vitest";

/**
 * Allow an explicit database path for tests that inspect file signatures. Other tests use a
 * temporary path.
 */
export async function createTestDB(dbPath?: string): Promise<DB> {
  dbPath ??= join(tmpdir(), `kozane-test-${randomUUID()}.db`);
  const client = createClient({ url: `file:${dbPath}` });
  const db = brandDb(drizzle(client, { schema }));
  await migrate(db, { migrationsFolder: resolve("drizzle") });
  onTestFinished(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });
  return db;
}

/**
 * SQLite's bound-parameter limit, checked against the driver. Tests that exceed it distinguish
 * namespace queries from queries that bind a list of card IDs.
 */
export const SQLITE_VARIABLE_MAX = 32_766;

/**
 * Insert `count` cards into one partition and layer with a recursive CTE. This creates large
 * fixtures without the round trips required by individual data API writes. Return IDs in
 * insertion order.
 */
export async function seedCards(
  db: AnyDB,
  { partitionId, layerId, count, prefix = "card" }: SeedCards,
): Promise<string[]> {
  if (count <= 0) return [];
  await db.run(sql`
    WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count}
    )
    INSERT INTO card (id, partition_id, layer_id, content, pos_x, pos_y, z_index, created_at, updated_at)
    SELECT ${prefix} || '-' || n, ${partitionId}, ${layerId}, 'card ' || n, 0, 0, 0, unixepoch(), unixepoch() FROM seq
  `);
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

type SeedCards = {
  partitionId: string;
  layerId: string;
  count: number;
  /** Distinguishes one seeded partition's ids from another's within a test. */
  prefix?: string;
};

/**
 * Recognize SQLite's parameter-count error through Drizzle's cause chain so unrelated query
 * failures cannot satisfy the assertion.
 */
export function isTooManyVariables(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /too many SQL variables/i.test(e.message) || isTooManyVariables(e.cause);
}
