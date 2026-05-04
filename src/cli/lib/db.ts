import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as schema from "../../db/schema.js";
import type { DB } from "../../db/tx.js";

export async function openDb(dbUrl: string): Promise<DB> {
  const client = createClient({ url: dbUrl });
  await client.execute("PRAGMA foreign_keys = ON");
  return drizzle(client, { schema }) as unknown as DB;
}

export async function runMigrations(dbUrl: string): Promise<void> {
  const client = createClient({ url: dbUrl });
  const db = drizzle(client, { schema });

  // Migrations are bundled relative to this file at build time.
  // At runtime (tsx or compiled): resolve from package root.
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/lib -> src/cli -> src -> project root
  const packageRoot = resolve(here, "../../..");
  const migrationsFolder = join(packageRoot, "drizzle");

  await migrate(db, { migrationsFolder });
  client.close();
}
