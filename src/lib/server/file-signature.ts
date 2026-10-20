import { closeSync, openSync, readSync, statSync } from "node:fs";
import { dbPathFromUrl, isMemoryDbUrl } from "../db-url.js";

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
 * Bytes in the first copy of the wal-index header at the start of the `-shm` file. See
 * https://www.sqlite.org/walformat.html.
 */
const WAL_INDEX_HEADER_BYTES = 48;

/**
 * The wal-index header as hex, or an empty string when there is no `-shm` file. Its change
 * counter, frame count, and salts move on every WAL commit. File metadata cannot be relied on
 * for that: after a checkpoint, SQLite rewrites the WAL from its start, so its size often stays
 * the same, and its mtime only moves once per kernel timestamp tick.
 */
function walIndexHeader(shmPath: string): string {
  let fd: number;
  try {
    fd = openSync(shmPath, "r");
  } catch {
    return "";
  }
  try {
    const header = Buffer.alloc(WAL_INDEX_HEADER_BYTES);
    const read = readSync(fd, header, 0, WAL_INDEX_HEADER_BYTES, 0);
    return header.subarray(0, read).toString("hex");
  } finally {
    closeSync(fd);
  }
}

/**
 * Combine signatures for a database file, its WAL sidecar, and the wal-index header. WAL
 * commits can change the sidecar while leaving the main file untouched, and can leave the
 * sidecar's metadata unchanged too, which the wal-index header catches. Return null for
 * databases without a local file signature.
 */
export function databaseSignature(dbUrl: string): string | null {
  if (isMemoryDbUrl(dbUrl)) return null;
  // Only local `file:` URLs can provide filesystem signatures.
  const path = dbPathFromUrl(dbUrl) ?? dbUrl;
  const main = fileSignature(path);
  if (!main) return null;
  return `${main}|${fileSignature(`${path}-wal`) ?? ""}|${walIndexHeader(`${path}-shm`)}`;
}
