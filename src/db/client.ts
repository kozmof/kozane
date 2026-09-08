import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDBURL } from "./internal/config.js";
import { isMemoryDbUrl } from "../lib/db-url.js";
import { applyConnectionPragmas } from "./pragmas.js";
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
  await applyConnectionPragmas(client, url);
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
 * How to hand back the connection {@link getDb} opened, so {@link resetDb} can close it.
 *
 * Held because `getDb` memoizes a `DB` and a `DB` has no way back to its client — the type
 * is drizzle's handle, and `close` lives on the libsql client underneath it. Without this,
 * `resetDb` dropped the promise and left the socket and file descriptors open: one leak per
 * call, which in a suite that resets between cases is one per test.
 */
let _dbClose: (() => void) | null = null;
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

/**
 * Forgets the process-wide connection, closing it first.
 *
 * Closing is the point: this is what a test calls between cases, and a `getDb` that had
 * opened a database left its client alive with nothing holding a reference to it. The close
 * is guarded because a connection already gone — the process exiting, a second reset — must
 * not turn tidying up into the error being reported.
 */
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
