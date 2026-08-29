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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether every value of a record satisfies `each`. An empty record passes, which is what a
 *  workspace with nothing cached yet writes. */
function everyValue(value: unknown, each: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(each);
}

function isTagHit(value: unknown): value is TagHit {
  if (!isRecord(value)) return false;
  if (typeof value.tag !== "string" || typeof value.excerpt !== "string") return false;
  const source = value.source;
  if (!isRecord(source)) return false;
  return source.kind === "card"
    ? typeof source.cardId === "string"
    : source.kind === "file" &&
        typeof source.taskspaceId === "string" &&
        typeof source.path === "string" &&
        typeof source.line === "number";
}

function isTagLineHit(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.tag === "string" &&
    typeof value.line === "number" &&
    typeof value.excerpt === "string"
  );
}

const isCachedCardHits = (value: unknown): boolean =>
  isRecord(value) &&
  Array.isArray(value.hits) &&
  value.hits.every(isTagHit) &&
  everyValue(value.cardProjects, (id) => typeof id === "string");

const isCachedFile = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.signature === "string" &&
  Array.isArray(value.hits) &&
  value.hits.every(isTagLineHit);

/**
 * Whether `value` is the cache this build writes — every field of it, down to each hit.
 *
 * Deep, and it has to be. Checking only the top level was enough to catch a foreign or older
 * file, which is what a cache written whole by an atomic rename can normally go wrong as; but
 * anything that got past it went straight into `loadTagIndex`, which spreads `hits` and reads
 * `source.kind` off each one. A file that was plausible at the top and wrong underneath —
 * hand-edited, or truncated and then repaired by something — therefore threw a `TypeError`
 * out of a page load and a `kozane tag` run, and kept throwing until someone deleted it. The
 * promise this module makes is that any doubt costs a rebuild and never an error, so the
 * doubt has to be looked for everywhere the answer is later trusted.
 *
 * The cost is a pass over data `JSON.parse` has just walked anyway — two `typeof`s a hit,
 * against a rebuild that reads every card in the workspace and re-parses every file.
 */
function isTagCache(value: unknown): value is TagCache {
  if (!isRecord(value)) return false;
  return (
    value.version === TAG_CACHE_VERSION &&
    typeof value.db === "string" &&
    everyValue(value.scopes, isCachedCardHits) &&
    everyValue(value.files, (entries) => everyValue(entries, isCachedFile))
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
