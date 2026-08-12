import { statSync } from "node:fs";

/**
 * Identity of the bytes currently at `path`, or null when nothing is there. Two reads that
 * produce the same signature read the same file contents, which is what lets a cache be
 * validated on every access instead of timed out — a rewritten file takes effect at once,
 * and an untouched one costs a single `stat` rather than an open, a read, and a parse.
 *
 * The inode is included because the atomic write these files use (write a temporary, then
 * rename it into place) replaces the file rather than truncating it, so a replacement is
 * visible even where the timestamp is not. Times are compared in nanoseconds so two writes
 * within the same millisecond cannot look alike either.
 */
export function fileSignature(path: string): string | null {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stats ? `${stats.ino}:${stats.mtimeNs}:${stats.size}` : null;
}
