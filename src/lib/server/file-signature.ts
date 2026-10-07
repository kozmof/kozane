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
 * - A file replaced by rename always looks different, because the new file has its own
 *   inode. Every file Kozane writes goes through `writeFileAtomic`, so every write Kozane
 *   makes is caught outright, whatever the clock did. Editors that save by rename — most
 *   of them — get the same treatment.
 * - A file rewritten in place keeps its inode, leaving mtime and size to separate the
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
 * and requiring it to be equal catches the write that lands inside the same filesystem
 * timestamp tick as the gather, which a "has anything happened since?" comparison waves
 * through. Any commit moves it — this server's own, another tab's, a `kozane card add` in
 * another terminal, a `db import`.
 *
 * The `-wal` is signed alongside, and under WAL — which is what a workspace runs in, see
 * `db/pragmas.ts` — it is the half that moves. A commit appends to the log and leaves the
 * main file untouched until a checkpoint, so signing the main file alone would report an
 * actively-written database as unchanged. This was already written this way before the mode
 * was set, which is why turning WAL on did not change what any cache here believes.
 *
 * Null for an in-memory database, which has no file to sign and no life beyond the process.
 */
/**
 * The filesystem path behind a `file:` URL, with the query stripped and any percent-escapes
 * undone.
 *
 * The decode is the part that was missing. A URL is percent-encoded by definition, so a
 * workspace under a directory with a space or a `#` in its name arrives here as
 * `file:/home/me/my%20notes/.kozane/kozane.db` — and `statSync` on that literal string finds
 * nothing, since no such file exists. `throwIfNoEntry: false` turns that into `null`, which
 * {@link databaseSignature} passes on, which switches the snapshot ETag gate and the tag
 * cache off: correct, and silently slower forever, on exactly the workspaces whose owners
 * are least likely to connect the two.
 *
 * Failing safe is why it was not urgent and not why it is fine. Undoing the escapes costs
 * one call and gives the caches back.
 *
 * `decodeURIComponent` throws on a lone `%` — a path that is not valid percent-encoding at
 * all — so a malformed URL falls back to the raw string rather than taking down a request.
 * That lands exactly where this started: no signature, no gate, no error.
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
  // libsql takes `file:/path`, optionally with query parameters; anything else is not a
  // local file this can stat.
  const path = decodeDbPath(dbUrl);
  const main = fileSignature(path);
  if (!main) return null;
  return `${main}|${fileSignature(`${path}-wal`) ?? ""}`;
}
