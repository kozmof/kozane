import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "../db/schema.js";
import type { DB } from "../db/tx.js";
import { resolve } from "path";

export async function createTestDB(): Promise<DB> {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema }) as unknown as DB;
  await migrate(db, { migrationsFolder: resolve("drizzle") });
  return db;
}
