import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDBURL } from "./internal/config.js";
import { resolveMigrationsFolder } from "./internal/migrations.js";
import * as schema from "./schema.js";
import type { DB } from "./tx.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

/**
 * A database and the means to hand it back, for a caller that opens one, asks it something,
 * and is done with it — `kozane doctor` above all, which reads a workspace it is not going
 * to go on serving.
 *
 * {@link createDb} keeps the client for the life of the process, which is right for the
 * server and for a `runWorkspaceCommand` that exits when its command does. It is not right
 * for a check that runs alongside others and returns, so the client is returned here rather
 * than closed over, the way the helpers in `cli/lib/db.ts` close theirs in a `finally`.
 */
export type OpenedDb = { db: DB; close: () => void };

export async function openDb(url: string): Promise<OpenedDb> {
  const client = createClient({ url });
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });

  if (url === ":memory:" || url === "file::memory:?cache=shared") {
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  }

  return { db: db as unknown as DB, close: () => client.close() };
}

export async function createDb(url: string): Promise<DB> {
  return (await openDb(url)).db;
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
