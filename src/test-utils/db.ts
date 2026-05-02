import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "../db/schema.js";
import { resolve } from "path";

export type TestDB = ReturnType<typeof drizzle<typeof schema>>;

export async function createTestDB(): Promise<TestDB> {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve("drizzle") });
  return db;
}
