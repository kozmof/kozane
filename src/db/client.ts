import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDBURL } from "./internal/config.js";
import { isMemoryDbUrl } from "../lib/db-url.js";
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

  if (isMemoryDbUrl(url)) {
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  }

  return { db: db as unknown as DB, close: () => client.close() };
}

export async function createDb(url: string): Promise<DB> {
  return (await openDb(url)).db;
}

let _dbPromise: Promise<DB> | null = null;
/**
 * The URL {@link getDb} opened, or null before it has opened one.
 *
 * Recorded rather than re-derived, because the two are not the same question. `getDBURL()`
 * reads the environment *now*; this is what the connection every request is served from was
 * actually built against. They agree today — `kozane open` passes `DATABASE_URL` explicitly,
 * including the temporary file a `--memory` server runs on — but the snapshot ETag gate in
 * `lib/server/snapshot-etag.ts` decides whether to answer 304 without reading the database,
 * and an answer about the wrong file is a stale board rather than a slow one. So it asks
 * which database is open instead of which one ought to be.
 */
let _openedDbUrl: string | null = null;

export async function getDb(): Promise<DB> {
  if (!_dbPromise) {
    const url = getDBURL();
    _dbPromise = createDb(url)
      .then((db) => {
        _openedDbUrl = url;
        return db;
      })
      .catch((e) => {
        _dbPromise = null;
        throw e;
      });
  }
  return _dbPromise;
}

/** The database {@link getDb} is serving from, or null when it has not opened one. */
export function openedDbUrl(): string | null {
  return _openedDbUrl;
}

export function resetDb(): void {
  _dbPromise = null;
  _openedDbUrl = null;
}
