import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import type { AnyDB, DB } from "../db/tx.js";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { onTestFinished } from "vitest";

export async function createTestDB(): Promise<DB> {
  const dbPath = join(tmpdir(), `kozane-test-${randomUUID()}.db`);
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db, { migrationsFolder: resolve("drizzle") });
  onTestFinished(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });
  return db;
}

/**
 * How many bound parameters SQLite will take in one statement.
 *
 * Confirmed against the driver rather than taken from the documentation: 32,766 is accepted
 * and 32,767 is refused. The reads that select by project exist because the ones that
 * select by id list cannot clear this on a board of any size, so a test crossing it is the
 * only one that actually distinguishes them.
 */
export const SQLITE_VARIABLE_MAX = 32_766;

/**
 * Inserts `count` cards onto one bundle and layer in a single statement.
 *
 * `addCards` would be the honest way to build a fixture, and is — up to a few hundred rows.
 * Crossing {@link SQLITE_VARIABLE_MAX} takes tens of thousands, which through the data API
 * is a couple of hundred round trips and through `addCard` tens of thousands. Nothing that
 * reads these rows parses an id or looks at the content, so a recursive CTE producing rows
 * that merely exist and belong to the bundle is the whole of what is needed.
 *
 * Returns the ids in insertion order.
 */
export async function seedCards(
  db: AnyDB,
  { bundleId, layerId, count, prefix = "card" }: SeedCards,
): Promise<string[]> {
  if (count <= 0) return [];
  await db.run(sql`
    WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count}
    )
    INSERT INTO card (id, bundle_id, layer_id, content, pos_x, pos_y, z_index)
    SELECT ${prefix} || '-' || n, ${bundleId}, ${layerId}, 'card ' || n, 0, 0, 0 FROM seq
  `);
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

type SeedCards = {
  bundleId: string;
  layerId: string;
  count: number;
  /** Distinguishes one seeded bundle's ids from another's within a test. */
  prefix?: string;
};

/**
 * Whether a rejection is SQLite refusing a statement's parameter count.
 *
 * Drizzle re-throws driver errors wrapped in a `Failed query: …` of its own, so the reason
 * is only ever in the cause chain — the same place `isUniqueConstraintError` looks for
 * one. Matching the reason rather than "it threw" is what keeps such a test from going on
 * passing once the query starts failing for some unrelated reason.
 */
export function isTooManyVariables(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /too many SQL variables/i.test(e.message) || isTooManyVariables(e.cause);
}
