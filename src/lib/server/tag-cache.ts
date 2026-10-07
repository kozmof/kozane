import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TAG_CACHE_BYTES_MAX, TAG_CACHE_DIRS_MAX, TAG_CACHE_SCOPES_MAX } from "../constants.js";
import { writeFileAtomic } from "./atomic-write.js";
import { databaseSignature } from "./file-signature.js";
import { evictRecord, setLast } from "./lru.js";
import { exportTaskspaceTagCache, importTaskspaceTagCache } from "./taskspace-tags.js";
import type { CardTagHits } from "../../db/api/tag.js";
import type { TagLineHit } from "../tag.js";
import type { CachedFile } from "./taskspace-tags.js";
import type { TagHit } from "../types.js";

// Re-export the shared database signature reader for existing callers.
export { databaseSignature };

/**
 * Persist gathered tags across page loads and process exits. Validate cached data against its
 * sources before use and rebuild missing or invalid files. Deleting the cache costs a fresh
 * gather.
 */

/** Bumped when the shape below changes. A file carrying any other value is ignored, which is
 *  what lets the shape change without a migration or a stale-format bug. */
export const TAG_CACHE_VERSION = 3;
export const TAG_CACHE_FILE = "tag-index.json";

export function tagCachePath(root: string): string {
  return join(root, ".kozane", TAG_CACHE_FILE);
}

/** Store the query's card-hit result type directly so changes to it also reach the cache type. */
export type CachedCardHits = CardTagHits;

/**
 * Share parsed-file cache entries with `taskspace-tags.ts`, which imports and exports the
 * same values.
 */
export type CachedFileEntry = CachedFile;

export type TagCache = {
  version: number;
  /** {@link databaseSignature} as it stood when the card hits below were gathered. */
  db: string;
  builtAt: string;
  /** Keyed by namespace id, or `*` for a gather across the whole workspace. */
  scopes: Record<string, CachedCardHits>;
  /** Keyed by resolved taskspace directory, then by path within it. */
  files: Record<string, Record<string, CachedFileEntry>>;
};

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

/** Use a type predicate so `every` narrows the cached hits after validating them. */
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
  everyValue(
    value.cardData,
    (card) =>
      isRecord(card) &&
      typeof card.namespaceId === "string" &&
      typeof card.partitionId === "string" &&
      typeof card.updatedDay === "string",
  ) &&
  everyValue(value.cardNamespaces, (id) => typeof id === "string") &&
  // Require the truncation flag so an older partial result cannot be read as complete.
  typeof value.truncated === "boolean";

const isCachedFile = (value: unknown): value is CachedFileEntry =>
  isRecord(value) &&
  typeof value.signature === "string" &&
  Array.isArray(value.hits) &&
  value.hits.every(isTagLineHit);

/**
 * Validate the complete cache shape, including individual hits, before trusting it. Invalid
 * nested data must trigger a rebuild instead of failing during a page load or CLI query.
 */
function isTagCache(value: unknown): value is TagCache {
  if (!isRecord(value)) return false;
  return (
    value.version === TAG_CACHE_VERSION &&
    typeof value.db === "string" &&
    // Validate every field promised by `TagCache`, including fields no current caller reads.
    typeof value.builtAt === "string" &&
    everyValue(value.scopes, isCachedCardHits) &&
    everyValue(value.files, (entries) => everyValue(entries, isCachedFile))
  );
}

/**
 * Read a validated cache or return null. Check size before reading to avoid blocking the
 * event loop on an oversized file. Missing, unreadable, and invalid caches are rebuilt by
 * callers.
 */
export function readTagCache(root: string): TagCache | null {
  const path = tagCachePath(root);
  let parsed: unknown;
  try {
    if (statSync(path).size > TAG_CACHE_BYTES_MAX) return null;
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Gather again if the cache is absent, unreadable, or invalid JSON.
    return null;
  }
  return isTagCache(parsed) ? parsed : null;
}

/**
 * Workspace roots already warned about oversized cache writes. Warn once per process to avoid
 * repeating the same message on every gather.
 */
const warnedOversizeRoots = new Set<string>();

/**
 * Explain a skipped oversized cache write once per workspace per process. The size is known
 * only after a gather attempts to save.
 */
function warnOversizeOnce(root: string): void {
  if (warnedOversizeRoots.has(root)) return;
  warnedOversizeRoots.add(root);
  console.warn(
    `[kozane] Tag cache exceeds ${Math.round(TAG_CACHE_BYTES_MAX / (1024 * 1024))}MB and will ` +
      "not be written; every page load and 'kozane tag' command will gather tags from " +
      "scratch until the workspace's tagged content shrinks back under the limit.",
  );
}

/**
 * Write the cache atomically without failing the caller if persistence fails.
 *
 * The surrounding read-modify-write is not locked. Concurrent gathers can replace each
 * other's entries, which costs a later rebuild but loses no source data.
 */
export function writeTagCache(root: string, cache: TagCache): void {
  try {
    const serialized = JSON.stringify(cache);
    // Do not write a cache the reader would reject. Measure UTF-8 bytes rather than string
    // length so the writer and file-size check use the same limit.
    if (Buffer.byteLength(serialized) > TAG_CACHE_BYTES_MAX) {
      warnOversizeOnce(root);
      return;
    }
    writeFileAtomic(tagCachePath(root), serialized);
  } catch {
    // Ignored: see above. `JSON.stringify` is inside the try for the same reason the write
    // is — a gather large enough to exceed the engine's maximum string length throws here,
    // and that is a cache that cannot be written, not a page that cannot be served.
  }
}

/** How a scope is named in the cache file. `*` is the gather across the whole workspace,
 *  which is a different set from any one namespace's and so a different entry. */
export const scopeKey = (namespaceId?: string) => namespaceId ?? "*";

export type SaveCache = {
  cards: CachedCardHits;
  /** Scanned taskspace directories and whether each scan changed cached data. */
  scanned?: { baseDir: string; changed: boolean }[];
  /** Whether any scan read or dropped something. See `TaskspaceTagScan.changed`. */
  changed: boolean;
};

/**
 * Open the persisted cache once per gather. Validate card hits against the database signature
 * and file entries against their own signatures before use. This module owns persistence and
 * eviction, while `tag-index.ts` gathers source data.
 */
export function openTagCache({
  root,
  dbUrl,
  namespaceId,
}: {
  root: string;
  dbUrl: string;
  /**
   * Optional namespace filter for this gather. Derive both the cache key and
   * directory-pruning policy from it so a namespace gather cannot prune other namespaces'
   * taskspaces.
   */
  namespaceId?: string;
}) {
  const scope = scopeKey(namespaceId);
  const signature = databaseSignature(dbUrl);
  // Skip persistent card-hit caching when the database has no signature to validate against.
  if (!signature) return null;

  const existing = readTagCache(root);
  // Invalidate card hits when the database changes. Keep file entries, which are validated
  // against their own files.
  const fresh = existing?.db === signature;
  const files = existing?.files ?? {};

  return {
    cards: (): CachedCardHits | null => (fresh ? (existing?.scopes[scope] ?? null) : null),

    seedFiles: (baseDir: string) => {
      const entries = files[baseDir];
      if (entries) importTaskspaceTagCache(baseDir, entries);
    },

    save: ({ cards, scanned = [], changed }: SaveCache) => {
      // Only workspace-wide gathers can identify taskspace directories that no longer exist
      // in the workspace.
      const live = namespaceId ? null : new Set(scanned.map(({ baseDir }) => baseDir));
      // Copy the record so `unchangedFrom` can compare the result with the original cached
      // value.
      const scopes = fresh ? { ...existing?.scopes } : {};
      // Reinsert the scope to make insertion order reflect access order for eviction.
      setLast(scopes, scope, cards);
      evictRecord(scopes, TAG_CACHE_SCOPES_MAX);

      const nextFiles: TagCache["files"] = {};
      for (const [baseDir, entries] of Object.entries(files)) {
        // Prune absent taskspace directories only after a workspace-wide gather. Namespace
        // gathers retain other directories, subject to the cache size limit.
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

      // Skip writing when all results came from the existing cache unchanged.
      if (!changed && unchangedFrom(existing, scope, cards, scopes, nextFiles)) return;

      writeTagCache(root, {
        version: TAG_CACHE_VERSION,
        // Store the pre-gather database signature. A mid-gather write then causes a mismatch
        // on the next load instead of making partially stale hits appear current.
        db: signature,
        builtAt: new Date().toISOString(),
        scopes,
        files: nextFiles,
      });
    },
  };
}

/**
 * Check whether cache bookkeeping changed. The content-change flag already covers rereads and
 * pruning, so key order and value identity are sufficient here.
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
