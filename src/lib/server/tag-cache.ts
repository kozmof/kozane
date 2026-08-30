import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TAG_CACHE_BYTES_MAX, TAG_CACHE_DIRS_MAX, TAG_CACHE_SCOPES_MAX } from "../constants.js";
import { writeFileAtomic } from "./atomic-write.js";
import { fileSignature } from "./file-signature.js";
import { evictRecord, setLast } from "./lru.js";
import { exportTaskspaceTagCache, importTaskspaceTagCache } from "./taskspace-tags.js";
import type { CardTagHits } from "../../db/api/tag.js";
import type { TagLineHit } from "../tag.js";
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
export const TAG_CACHE_VERSION = 2;
export const TAG_CACHE_FILE = "tag-index.json";

export function tagCachePath(root: string): string {
  return join(root, ".kozane", TAG_CACHE_FILE);
}

/**
 * One scope's card hits, as `getCardTagHits` returned them — the return type itself, rather
 * than a record of the same two fields written out again here.
 *
 * The same reason {@link CachedFileEntry} below is a re-export: this is stored and read back
 * as exactly what that query produced, so a field added to `CardTagHits` must either be
 * stored too or be a deliberate omission, and a structural copy would have made it neither.
 */
export type CachedCardHits = CardTagHits;

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

/** A predicate rather than a `boolean`, as {@link isTagHit} is: the `every` below is the only
 *  thing that establishes what a cached file's `hits` hold, so it should be what narrows
 *  them. */
function isTagLineHit(value: unknown): value is TagLineHit {
  return (
    isRecord(value) &&
    typeof value.tag === "string" &&
    typeof value.line === "number" &&
    typeof value.excerpt === "string"
  );
}

const isCachedCardHits = (value: unknown): value is CachedCardHits =>
  isRecord(value) &&
  Array.isArray(value.hits) &&
  value.hits.every(isTagHit) &&
  everyValue(value.cardProjects, (id) => typeof id === "string") &&
  // Required rather than defaulted, which is what the version above is for. A file written
  // before this field existed carries a complete-looking hit list that was in fact cut, and
  // reading it as `truncated: false` would restore the exact silence the field was added to
  // end — for as long as the database signature stayed fresh.
  typeof value.truncated === "boolean";

const isCachedFile = (value: unknown): value is CachedFileEntry =>
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

/**
 * The cache as it stands, or null when there is not a usable one. Never throws.
 *
 * Size is checked before the file is opened, and it is the one check that cannot be made
 * after: this runs on the path a page load waits on, so a cache grown past
 * {@link TAG_CACHE_BYTES_MAX} is refused for costing more to read than the gather it saves —
 * a `readFileSync` and a `JSON.parse` that block this process throughout. Reading it and
 * then deciding would be the whole cost, followed by throwing the result away.
 *
 * One extra `stat` of a file about to be read anyway, against a rebuild that queries every
 * card in the workspace and re-parses every taskspace file. See {@link TAG_CACHE_BYTES_MAX}
 * for why the answer is to rebuild rather than to trim.
 */
export function readTagCache(root: string): TagCache | null {
  const path = tagCachePath(root);
  let parsed: unknown;
  try {
    if (statSync(path).size > TAG_CACHE_BYTES_MAX) return null;
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Absent, unreadable, or not JSON. All three mean the same thing here: gather afresh.
    return null;
  }
  return isTagCache(parsed) ? parsed : null;
}

/**
 * Writes the cache, atomically. Best-effort: a workspace on a read-only filesystem, or two
 * processes finishing a gather at once, must not fail the page that was being served.
 *
 * Atomic per write, and deliberately nothing more. The read-modify-write around it is not:
 * a `kozane tag list` finishing between this server's read and its write replaces the file
 * wholesale, so the scope entry the CLI never knew about is gone — not merely re-derived
 * later, but absent from the file until something gathers that scope again. That is a cost
 * of a cold read for whoever asks next, and it is the reason a lock is not worth having
 * here: nothing durable is lost, because nothing in this file is a record of anything. Every
 * part of it is checked against the thing it came from before it is believed.
 */
export function writeTagCache(root: string, cache: TagCache): void {
  try {
    const serialized = JSON.stringify(cache);
    // Not written if it could not be read back. `readTagCache` refuses a file past this
    // ceiling, so laying one down produces a file this build has already decided to ignore
    // — and then re-serializes and re-writes it on every gather, paying megabytes of
    // `stringify` and a disk write per page load for a cache nothing will ever read. A
    // workspace this size pays a cold read; it should not also pay a hot write.
    //
    // In bytes rather than in `length`, which counts UTF-16 code units: an excerpt of
    // Japanese is three bytes a character and one unit, so the two disagree by a factor of
    // three on exactly the content this cache is full of — and it is the byte count that
    // `readTagCache` will `stat`.
    if (Buffer.byteLength(serialized) > TAG_CACHE_BYTES_MAX) return;
    writeFileAtomic(tagCachePath(root), serialized);
  } catch {
    // Ignored: see above. `JSON.stringify` is inside the try for the same reason the write
    // is — a gather large enough to exceed the engine's maximum string length throws here,
    // and that is a cache that cannot be written, not a page that cannot be served.
  }
}

/** How a scope is named in the cache file. `*` is the gather across the whole workspace,
 *  which is a different set from any one project's and so a different entry. */
export const scopeKey = (projectId?: string) => projectId ?? "*";

export type SaveCache = {
  cards: CachedCardHits;
  /** The taskspace directories this gather walked, each with whether its scan learned
   *  anything — which decides between re-exporting its entries and keeping the stored ones. */
  scanned?: { baseDir: string; changed: boolean }[];
  /** Whether any scan read or dropped something. See `TaskspaceTagScan.changed`. */
  changed: boolean;
};

/**
 * The persisted gather, opened once per `loadTagIndex` call.
 *
 * Reading the file is the only I/O this does up front. What it hands back is checked before
 * use — card hits against the database's signature, file entries against each file's own —
 * so a cache that has fallen behind costs a re-gather and never a wrong answer.
 *
 * Here rather than in `tag-index.ts`, where it was. This is the cache's policy — what is kept
 * fresh, what is evicted and in what order, and when writing is worth doing — and it is
 * longer than the gather it was wrapped around, which left that module's one exported
 * function reading as a footnote to it. The two modules now divide as their names say: this
 * one owns the file, its shape, and its rules; `tag-index.ts` owns reading a workspace.
 */
export function openTagCache({
  root,
  dbUrl,
  projectId,
}: {
  root: string;
  dbUrl: string;
  /**
   * The project this gather is narrowed to, or omitted for one across the whole workspace.
   *
   * Taken once, here, rather than handed to each call below — which is what makes the scope
   * key and the eviction rule that depends on it one decision instead of two that have to
   * agree. `save` used to be given a scope string and, separately, the set of directories it
   * was allowed to presume complete; the caller built the second with
   * `...(projectId ? {} : { live })` and the two type-checked in every combination, including
   * the one that tells a workspace-wide store that a project's taskspaces are all there are.
   * Neither is passed now: both are derived from this.
   */
  projectId?: string;
}) {
  const scope = scopeKey(projectId);
  const signature = databaseSignature(dbUrl);
  // No signature means nothing to validate card hits against — an in-memory database, or one
  // that is not a local file. Rather than cache what cannot be checked, do not cache.
  if (!signature) return null;

  const existing = readTagCache(root);
  // Card hits are kept only while the database is byte-for-byte the one they came from. File
  // entries are not thrown away with them: they answer to their own files, and a card written
  // in the browser says nothing about what is on disk.
  const fresh = existing?.db === signature;
  const files = existing?.files ?? {};

  return {
    cards: (): CachedCardHits | null => (fresh ? (existing?.scopes[scope] ?? null) : null),

    seedFiles: (baseDir: string) => {
      const entries = files[baseDir];
      if (entries) importTaskspaceTagCache(baseDir, entries);
    },

    save: ({ cards, scanned = [], changed }: SaveCache) => {
      // Only a gather across the whole workspace read every taskspace there is, so only it
      // can tell a stored directory that is gone from one that simply belongs to another
      // project. Derived from the project this store was opened for rather than passed in
      // beside the scope — see the note there.
      const live = projectId ? null : new Set(scanned.map(({ baseDir }) => baseDir));
      // A copy, because what is read from is what is compared against below: `unchangedFrom`
      // asks whether the record about to be written is the one already on disk, and it could
      // not if this had been built by editing that one.
      const scopes = fresh ? { ...existing?.scopes } : {};
      // Re-set rather than merely set, so a scope looked at again moves to the end: that is
      // what makes insertion order visit order, and the eviction below oldest-out.
      setLast(scopes, scope, cards);
      evictRecord(scopes, TAG_CACHE_SCOPES_MAX);

      const nextFiles: TagCache["files"] = {};
      for (const [baseDir, entries] of Object.entries(files)) {
        // A gather that saw every taskspace in the workspace knows which directories are
        // still taskspaces, so one that is not among them is gone and its entries go with
        // it. A gather narrowed to one project knows nothing about the others' and keeps
        // them — the bound below is what answers for that case.
        if (live && !live.has(baseDir)) continue;
        nextFiles[baseDir] = entries;
      }
      for (const { baseDir, changed: moved } of scanned) {
        // The entries this process holds, but only where they can differ from what is
        // already stored. Exporting rebuilds the record, and a fresh object of identical
        // contents is what would make the no-op check below fail and write anyway.
        const kept = nextFiles[baseDir];
        const entries = moved || !kept ? exportTaskspaceTagCache(baseDir) : kept;
        // Re-set even when it was already there, so a directory looked at again moves to the
        // end of the insertion order the eviction below reads as least-recently-used.
        if (entries) setLast(nextFiles, baseDir, entries);
        else delete nextFiles[baseDir];
      }
      evictRecord(nextFiles, TAG_CACHE_DIRS_MAX);

      // Nothing new to say. The gather answered from the file it would be rewriting, so
      // writing it back would serialize a megabyte and replace the file with itself — once
      // per page load, and once per `kozane tag` invocation. The `builtAt` stamp is the only
      // thing that would differ, and nothing reads it.
      if (!changed && unchangedFrom(existing, scope, cards, scopes, nextFiles)) return;

      writeTagCache(root, {
        version: TAG_CACHE_VERSION,
        // The signature read *before* the gather, deliberately, and never a fresher one. A
        // write that lands mid-gather leaves hits that are neither the old state nor quite
        // the new one; stamping what the database looks like now would declare them current
        // and serve them until the next write. Stamping what it looked like when they were
        // taken means the next load finds a mismatch and gathers again — one wasted gather
        // instead of a wrong answer that persists.
        db: signature,
        builtAt: new Date().toISOString(),
        scopes,
        files: nextFiles,
      });
    },
  };
}

/**
 * Whether the file on disk already says exactly this.
 *
 * Deliberately shallow, and it can be: `changed` has already ruled out the two ways the
 * *contents* move — a re-queried card set and a re-read or pruned file. What is left for this
 * to catch is the bookkeeping around them. Identity is the right test for the values, because
 * every one of them came out of `existing` moments ago and was put back unchanged; a key
 * comparison catches an eviction or a first visit that rearranged the maps without altering
 * anything in them.
 */
function unchangedFrom(
  existing: TagCache | null,
  scope: string,
  cards: CachedCardHits,
  scopes: TagCache["scopes"],
  files: TagCache["files"],
): boolean {
  if (!existing || existing.scopes[scope] !== cards) return false;
  return sameOrder(existing.scopes, scopes) && sameOrder(existing.files, files);
}

/** Same keys, in the same order, each holding the very same value. Order counts because it is
 *  what both evictions above read as least-recently-used. */
function sameOrder(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  const next = Object.keys(b);
  return (
    keys.length === next.length && keys.every((key, i) => next[i] === key && a[key] === b[key])
  );
}
