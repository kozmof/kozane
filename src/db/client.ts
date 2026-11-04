import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrateNodeDatabase as migrate } from "./tx.js";
import { getDBURL } from "./internal/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDbUrl, isMemoryDbUrl } from "../lib/db-url.js";
import { applyConnectionPragmas, BUSY_TIMEOUT_MS } from "./pragmas.js";
import { resolveMigrationsFolder } from "./internal/migrations.js";
import * as schema from "./schema.js";
import { brandDb, type DB } from "./tx.js";

export type { DB, Tx, ReadTx, AnyDB } from "./tx.js";
export { withTx, withReadTx } from "./tx.js";

/**
 * Database handle and cleanup function for callers that open a short-lived connection. Close
 * it when finished, including on failure.
 */
export type OpenedDb = { db: DB; close: () => void };

export async function openDb(url: string): Promise<OpenedDb> {
  if (isMemoryDbUrl(url)) return openTemporaryDb();
  // Set the client timeout for new connections after the transaction. A connection-local
  // pragma is insufficient.
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS });
  await applyConnectionPragmas(client, url);
  return { db: brandDb(drizzle(client, { schema })), close: () => client.close() };
}

/**
 * Serve an in-memory URL from a fresh file that is deleted on close. libsql hands its
 * connection to each transaction and opens a new one afterwards, and a new `:memory:`
 * connection is a separate, empty database, so everything would vanish after the first
 * transaction. `kozane open --memory` uses a temporary file for the same reason.
 */
async function openTemporaryDb(): Promise<OpenedDb> {
  const dir = mkdtempSync(join(tmpdir(), "kozane-memory-db-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    const opened = await openDb(fileDbUrl(join(dir, "kozane.db")));
    await migrate(opened.db, { migrationsFolder: resolveMigrationsFolder() });
    return {
      db: opened.db,
      close: () => {
        try {
          opened.close();
        } finally {
          remove();
        }
      },
    };
  } catch (e) {
    remove();
    throw e;
  }
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
    const opening: Promise<DB> = openDb(url)
      .then(({ db, close }) => {
        // Close this connection because `resetDb` cleared the cached state while it was opening.
        if (_dbPromise !== opening) {
          close();
          throw new Error("Database connection was reset while opening");
        }
        _openedDbUrl = url;
        _dbClose = close;
        return db;
      })
      .catch((e) => {
        if (_dbPromise === opening) _dbPromise = null;
        throw e;
      });
    _dbPromise = opening;
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
