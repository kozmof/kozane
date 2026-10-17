/**
 * Classify and build database URLs without opening them. Keep this module independent of
 * filesystem and database code so configuration, connection, and cache readers can share it.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Recognize libsql's in-memory URL forms, including `:memory:` and `file::memory:` with
 * optional query parameters. Do not mistake a file path containing `:memory:` for an
 * in-memory database.
 */
export function isMemoryDbUrl(url: string): boolean {
  return url === ":memory:" || url === "file::memory:" || url.startsWith("file::memory:?");
}

/**
 * Build the `file:` URL for a local database path. Percent-encode it so a workspace path
 * containing `#`, `?`, or `%` names the file it should: libsql rejects a raw `#` as a
 * fragment and would read a raw `%41` as an escape.
 */
export function fileDbUrl(path: string): string {
  return pathToFileURL(path).href;
}

/**
 * The local path a `file:` URL names, with query parameters stripped and percent escapes
 * decoded, or null for in-memory and non-file URLs. Accept both the encoded `file:///` form
 * {@link fileDbUrl} builds and the bare `file:/path` form a hand-written `DATABASE_URL` may
 * use. If decoding fails, use the raw path so malformed input does not throw.
 */
export function dbPathFromUrl(url: string): string | null {
  if (isMemoryDbUrl(url) || !url.startsWith("file:")) return null;
  const withoutQuery = url.split("?")[0];
  if (withoutQuery.startsWith("file://")) {
    try {
      return fileURLToPath(withoutQuery);
    } catch {
      // Fall through to the bare form below.
    }
  }
  const raw = withoutQuery.slice("file:".length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
