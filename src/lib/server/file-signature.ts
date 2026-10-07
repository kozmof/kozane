import { statSync } from "node:fs";
import { isMemoryDbUrl } from "../db-url.js";

/**
 * Return an inode, modification-time, and size signature, or null for a missing file. Caches
 * use it to avoid rereading unchanged content.
 *
 * Atomic replacement changes the inode. In-place writes rely on timestamp and size changes,
 * so same-length writes within one filesystem timestamp tick can be missed. This is a
 * metadata heuristic, not a content hash.
 */
export function fileSignature(path: string): string | null {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stats ? `${stats.ino}:${stats.mtimeNs}:${stats.size}` : null;
}

/**
 * Combine signatures for a database file and its WAL sidecar. WAL commits can change the
 * sidecar while leaving the main file untouched. Return null for databases without a local
 * file signature.
 */
/**
 * Extract a local path from a `file:` URL, strip query parameters, and decode percent
 * escapes. If decoding fails, use the raw path so malformed input does not throw during a
 * cache check.
 */
function decodeDbPath(dbUrl: string): string {
  const raw = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length).split("?")[0] : dbUrl;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function databaseSignature(dbUrl: string): string | null {
  if (isMemoryDbUrl(dbUrl)) return null;
  // Only local `file:` URLs can provide filesystem signatures.
  const path = decodeDbPath(dbUrl);
  const main = fileSignature(path);
  if (!main) return null;
  return `${main}|${fileSignature(`${path}-wal`) ?? ""}`;
}
