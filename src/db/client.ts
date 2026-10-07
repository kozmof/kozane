import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDBURL } from "./internal/config.js";
import { isMemoryDbUrl } from "../lib/db-url.js";
import { applyConnectionPragmas, BUSY_TIMEOUT_MS } from "./pragmas.js";
import { resolveMigrationsFolder } from "./internal/migrations.js";
import * as schema from "./schema.js";
import { brandDb, type DB } from "./tx.js";

export type { DB, Tx, AnyDB } from "./tx.js";
export { withTx } from "./tx.js";

/**
 * Database handle and cleanup function for callers that open a short-lived connection. Close
 * it when finished, including on failure.
 */
export type OpenedDb = { db: DB; close: () => void };

export async function openDb(url: string): Promise<OpenedDb> {
  // Set the client timeout for new connections after the transaction. A connection-local
  // pragma is insufficient.
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS });
  await applyConnectionPragmas(client, url);
  const db = drizzle(client, { schema });

  if (isMemoryDbUrl(url)) {
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  }

  return { db: brandDb(db), close: () => client.close() };
}

export async function createDb(url: string): Promise<DB> {
  return (await openDb(url)).db;
}

let _dbPromise: Promise<DB> | null = null;
/**
 * Cleanup function for the connection cached by {@link getDb}. The Drizzle handle does not
 * expose the underlying client's close operation.
 */
let _dbClose: (() => void) | null = null;
/**
 * URL of the cached connection, or null before it opens. File-based cache checks must inspect
 * this database rather than resolving a URL from the current environment again.
 */
let _openedDbUrl: string | null = null;

export async function getDb(): Promise<DB> {
  if (!_dbPromise) {
    const url = getDBURL();
    _dbPromise = openDb(url)
      .then(({ db, close }) => {
        _openedDbUrl = url;
        _dbClose = close;
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

/** Close and forget the process-wide connection. Ignore close failures during cleanup. */
export function resetDb(): void {
  try {
    _dbClose?.();
  } catch {
    // Already closed, or never fully opened. Nothing here depends on it having worked.
  }
  _dbPromise = null;
  _openedDbUrl = null;
  _dbClose = null;
}
