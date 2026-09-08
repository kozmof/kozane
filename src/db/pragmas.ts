import type { Client } from "@libsql/client";
import { isMemoryDbUrl } from "../lib/db-url.js";

/**
 * How long a connection waits for a lock before giving up. Long enough to cover a `kozane
 * card add` landing while the board polls, short enough that a genuinely stuck writer
 * surfaces as an error rather than as a request that never answers.
 */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * The pragmas every connection to a workspace database opens with.
 *
 * Gathered here because they were not the same everywhere. `openDb` set `busy_timeout` and
 * `foreign_keys`; `runMigrations` and the backup and restore helpers set only
 * `busy_timeout` — so whether a cascade was enforced depended on which entry point had
 * opened the database, which is not a thing a caller should have to know. It is a leaf
 * module for the reason `lib/db-url.ts` is: `cli/lib/db.ts` needs it and must not pull in
 * `db/client.ts`'s drizzle instance to get it.
 *
 * ## `journal_mode = WAL`
 *
 * Kozane is one database with two writers — the server and whatever the person types in
 * another terminal — and under the default rollback journal a writer takes an exclusive
 * lock over the whole file. A `kozane card add` therefore blocked every reader for the
 * length of its transaction, and the board's once-a-second poll simply sat in
 * `busy_timeout` until it cleared. Under WAL a writer no longer excludes readers, so the
 * poll is answered from the last committed state while the write is still in flight.
 *
 * The rest of the code was already written for this. `databaseSignature` signs the `-wal`
 * beside the main file, which is what keeps the snapshot ETag gate and the tag cache
 * correct once commits stop moving the main file until a checkpoint; `restoreDb` removes
 * both sidecars after swapping a database in, because a log left beside a replaced file
 * describes a history that file never had; and `kozane open --memory` builds its database
 * inside a temporary directory it removes whole, sidecars included.
 *
 * The mode is a property of the file rather than of the connection, so this is what sets
 * it and every later opener inherits it — including the ones that do not call this, such as
 * the read-only client behind `getMigrationStatus`. Issuing it again on an already-WAL
 * database is a no-op.
 *
 * Skipped for an in-memory database, which has no file to keep a log beside and cannot
 * leave WAL. SQLite answers such a request with the mode it kept rather than an error, so
 * this is about saying what is meant rather than about avoiding a throw.
 */
export async function applyConnectionPragmas(client: Client, url: string): Promise<void> {
  await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  await client.execute("PRAGMA foreign_keys = ON");
  if (!isMemoryDbUrl(url)) await client.execute("PRAGMA journal_mode = WAL");
}
