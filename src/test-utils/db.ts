import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "../db/schema.js";
import type { DB } from "../db/tx.js";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

export async function createTestDB(): Promise<DB> {
  const dbPath = join(tmpdir(), `kozane-test-${randomUUID()}.db`);
  const client = createClient({ url: `file:${dbPath}` });
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db, { migrationsFolder: resolve("drizzle") });
  return db;
}
