import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { fileSignature } from "./file-signature.js";
import type { CachedFile } from "./taskspace-tags.js";
import type { TagHit } from "../types.js";

/**
 * The gathered tags of a workspace, kept on disk so a gather survives a page navigation and
 * a process exit.
 *
 * The file is a cache and nothing else. It is never read as the source of truth about
 * anything: every part of it is checked against the thing it was derived from before it is
 * used, and any doubt at all — missing, truncated, hand-edited, written by a version that
 * spelled it differently — is answered by rebuilding rather than by an error. Deleting it
 * costs one slow load.
 */

/** Bumped when the shape below changes. A file carrying any other value is ignored, which is
 *  what lets the shape change without a migration or a stale-format bug. */
export const TAG_CACHE_VERSION = 1;
export const TAG_CACHE_FILE = "tag-index.json";

export function tagCachePath(root: string): string {
  return join(root, ".kozane", TAG_CACHE_FILE);
}

/** One scope's card hits, as `getCardTagHits` returned them. */
export type CachedCardHits = { hits: TagHit[]; cardProjects: Record<string, string> };

/**
 * One file's tags, against the identity of the bytes they were parsed from — re-exported
 * from `taskspace-tags.ts` rather than declared again here.
 *
 * The two modules hand these entries back and forth through `importTaskspaceTagCache` and
 * `exportTaskspaceTagCache`, so they have to agree about the shape; declaring it twice meant
 * nothing but a convention made them, and a field added on one side would have type-checked
 * on both.
 */
export type CachedFileEntry = CachedFile;

export type TagCache = {
  version: number;
  /** {@link databaseSignature} as it stood when the card hits below were gathered. */
  db: string;
  builtAt: string;
  /** Keyed by project id, or `*` for a gather across the whole workspace. */
  scopes: Record<string, CachedCardHits>;
  /** Keyed by resolved taskspace directory, then by path within it. */
  files: Record<string, Record<string, CachedFileEntry>>;
};

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
  if (dbUrl.includes(":memory:")) return null;
  // libsql takes `file:/path`, optionally with query parameters; anything else is not a
  // local file this can stat.
  const path = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length).split("?")[0] : dbUrl;
  const main = fileSignature(path);
  if (!main) return null;
  return `${main}|${fileSignature(`${path}-wal`) ?? ""}`;
}

/** Whether `value` is shaped like the cache this build writes. Structural rather than deep:
 *  the file is this program's own, written whole by an atomic rename, so what this has to
 *  catch is a foreign or older file — not a crafted one, which is as trusted as the database
 *  sitting beside it. */
function isTagCache(value: unknown): value is TagCache {
  if (typeof value !== "object" || value === null) return false;
  const cache = value as Partial<TagCache>;
  return (
    cache.version === TAG_CACHE_VERSION &&
    typeof cache.db === "string" &&
    typeof cache.scopes === "object" &&
    cache.scopes !== null &&
    typeof cache.files === "object" &&
    cache.files !== null
  );
}

/** The cache as it stands, or null when there is not a usable one. Never throws. */
export function readTagCache(root: string): TagCache | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(tagCachePath(root), "utf-8"));
  } catch {
    // Absent, unreadable, or not JSON. All three mean the same thing here: gather afresh.
    return null;
  }
  return isTagCache(parsed) ? parsed : null;
}

/**
 * Writes the cache, atomically. Best-effort: a workspace on a read-only filesystem, or two
 * processes finishing a gather at once, must not fail the page that was being served — the
 * loser of such a race simply did work that will be done again.
 */
export function writeTagCache(root: string, cache: TagCache): void {
  try {
    writeFileAtomic(tagCachePath(root), JSON.stringify(cache));
  } catch {
    // Ignored: see above.
  }
}
