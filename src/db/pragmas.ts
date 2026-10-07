import type { Client } from "@libsql/client";
import { isMemoryDbUrl } from "../lib/db-url.js";

/**
 * How long a connection waits for a lock before giving up. Long enough to cover a `kozane
 * card add` landing while the board polls, short enough that a genuinely stuck writer
 * surfaces as an error rather than as a request that never answers.
 */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Apply shared connection settings for workspace databases. Keep this module independent of
 * `db/client.ts` so CLI database helpers can use it without creating the application's Drizzle
 * instance.
 *
 * WAL lets the server read committed data while a CLI command writes. `databaseSignature`
 * includes the WAL file so caches detect commits before a checkpoint updates the main file.
 * Restore removes the sidecar files, and memory sessions remove their whole temporary
 * directory.
 *
 * Journal mode persists on the database file, so later connections inherit WAL. Skip this
 * setting for in-memory databases, which cannot use WAL.
 */
export async function applyConnectionPragmas(client: Client, url: string): Promise<void> {
  await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  await client.execute("PRAGMA foreign_keys = ON");
  if (!isMemoryDbUrl(url)) await client.execute("PRAGMA journal_mode = WAL");
}
