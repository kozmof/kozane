import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDBURL } from "./internal/config.js";
import { resolveMigrationsFolder } from "./internal/migrations.js";
import * as schema from "./schema.js";
import type { DB } from "./tx.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

export async function createDb(url: string): Promise<DB> {
  const client = createClient({ url });
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });

  if (url === ":memory:" || url === "file::memory:?cache=shared") {
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  }

  return db as unknown as DB;
}

let _dbPromise: Promise<DB> | null = null;

export async function getDb(): Promise<DB> {
  if (!_dbPromise) {
    _dbPromise = createDb(getDBURL()).catch((e) => {
      _dbPromise = null;
      throw e;
    });
  }
  return _dbPromise;
}

export function resetDb(): void {
  _dbPromise = null;
}
