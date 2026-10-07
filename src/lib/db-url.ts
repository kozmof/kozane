/**
 * Classify database URLs without opening them. Keep this module independent of filesystem and
 * database code so configuration, connection, and cache readers can share it.
 */

/**
 * Recognize libsql's in-memory URL forms, including `:memory:` and `file::memory:` with
 * optional query parameters. Do not mistake a file path containing `:memory:` for an
 * in-memory database.
 */
export function isMemoryDbUrl(url: string): boolean {
  return url === ":memory:" || url === "file::memory:" || url.startsWith("file::memory:?");
}
