import { statSync } from "node:fs";
import { isMemoryDbUrl } from "../db-url.js";

/**
 * Identity of the bytes currently at `path`, or null when nothing is there. It lets a
 * cache be validated on every access instead of timed out — a rewritten file takes effect
 * at once, and an untouched one costs a single `stat` rather than an open, a read, and a
 * parse.
 *
 * What it actually guarantees, in the order the fields earn their place:
 *
 * - **A file replaced by rename always looks different**, because the new file has its own
 *   inode. Every file Kozane writes goes through `writeFileAtomic`, so every write Kozane
 *   makes is caught outright, whatever the clock did. Editors that save by rename — most
 *   of them — get the same treatment.
 * - **A file rewritten in place** keeps its inode, leaving mtime and size to separate the
 *   versions. That covers a person editing the config and covers any change of length, but
 *   it is not absolute: two same-length writes within one filesystem timestamp tick are
 *   genuinely indistinguishable here. `mtimeNs` reports nanoseconds but is not ticked at
 *   that resolution, so the precision is in the units, not in the value.
 *
 * The gap is left rather than closed because closing it means hashing the contents, and
 * reading the file on every check is the exact cost this exists to avoid. It is out of
 * reach of the thing this protects — a human editing a file cannot type twice inside one
 * tick — and out of reach of Kozane's own writers, which rename.
 */
export function fileSignature(path: string): string | null {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stats ? `${stats.ino}:${stats.mtimeNs}:${stats.size}` : null;
}

/**
 * Identity of the database behind `dbUrl`, or null where there is nothing to identify it by.
 *
 * `fileSignature` rather than a stored timestamp compared with `>`: it is `ino:mtimeNs:size`,
 * and requiring it to be *equal* catches the write that lands inside the same filesystem
 * timestamp tick as the gather, which a "has anything happened since?" comparison waves
 * through. Any commit moves it — this server's own, another tab's, a `kozane card add` in
 * another terminal, a `db import`.
 *
 * The `-wal` is signed alongside, though nothing here turns WAL on: `journal_mode` is
 * `delete`, so today every write moves the main file itself. Under WAL it would not, until a
 * checkpoint — so signing both is what keeps this correct if that ever changes, and costs one
 * `stat` of a file that is usually absent.
 *
 * Null for an in-memory database, which has no file to sign and no life beyond the process.
 */
export function databaseSignature(dbUrl: string): string | null {
  if (isMemoryDbUrl(dbUrl)) return null;
  // libsql takes `file:/path`, optionally with query parameters; anything else is not a
  // local file this can stat.
  const path = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length).split("?")[0] : dbUrl;
  const main = fileSignature(path);
  if (!main) return null;
  return `${main}|${fileSignature(`${path}-wal`) ?? ""}`;
}
