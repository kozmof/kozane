import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrateNodeDatabase as migrate } from "../db/tx.js";
import * as schema from "../db/schema.js";
import { brandDb, type DB } from "../db/tx.js";
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

export * from "./db-common.js";
