import {
  TAG_CACHE_DIRS_MAX,
  TAG_CACHE_FILES_MAX,
  TAG_SCAN_DEPTH_MAX,
  TAG_SCAN_HITS_MAX,
  TAG_SCAN_NODES_MAX,
  TAG_SCAN_SKIP_DIRS,
  TAG_SCAN_TOTAL_BYTES_MAX,
  TAG_SCAN_TRUNCATED_PATHS_MAX,
  TAG_SCAN_WORKSPACE_BYTES_MAX,
  TAG_SCAN_WORKSPACE_NODES_MAX,
  TASKSPACE_FILE_BYTES_MAX,
} from "../constants.js";
import { scanTagLines, type TagLineHit } from "../tag.js";
import type { TagHit, TagScanTruncation } from "../types.js";
import { evict, touch, touchOrCreate } from "./lru.js";
import { listTaskspaceDirectory, readTaskspaceFile } from "./taskspace-files.js";

/**
 * Scan taskspace files for tags through the shared directory and file readers. Reuse their
 * containment, hidden-file, symlink, size, and UTF-8 checks.
 *
 * Also skip {@link TAG_SCAN_SKIP_DIRS} so generated output does not consume the budget before
 * authored files.
 */

/**
 * Remaining scan budget. Track spending as directories and files are read, as `Budget` does
 * in `taskspace-snapshot.ts`.
 */
type Budget = { remaining: number; nodes: number };

/**
 * Per-taskspace scan limits, overridable for tests. `files` bounds retained cache entries
 * rather than work performed during the scan.
 */
export type TaskspaceScanLimits = {
  bytes?: number;
  nodes?: number;
  depth?: number;
  hits?: number;
  files?: number;
};

/** What a whole gather may spend, across every taskspace in it. See {@link ScanPool}. */
export type GatherScanLimits = { workspaceBytes?: number; workspaceNodes?: number };

/**
 * Separate workspace and taskspace limit overrides into named fields so each consumer
 * receives only its own limits.
 */
export type ScanLimits = { taskspace?: TaskspaceScanLimits; gather?: GatherScanLimits };

/**
 * Remaining workspace-wide budget shared by all taskspace scans. Each scan spends at most its
 * own limit and the pool's remaining allowance.
 */
export type ScanPool = { bytes: number; nodes: number };

export const createScanPool = (limits: GatherScanLimits = {}): ScanPool => ({
  bytes: limits.workspaceBytes ?? TAG_SCAN_WORKSPACE_BYTES_MAX,
  nodes: limits.workspaceNodes ?? TAG_SCAN_WORKSPACE_NODES_MAX,
});

export type TaskspaceTagScan = {
  hits: TagHit[];
  /**
   * The limits this scan stopped at, empty when it read the whole taskspace. A tag index
   * that says nothing about a taskspace it only half-read is telling the user their tag is
   * not there when it may well be.
   */
  truncated: TagScanTruncation[];
  /**
   * Whether the taskspace root could not be opened. Report unavailable roots separately from
   * truncated scans. An unreadable directory below the root remains a truncation.
   */
  missing: boolean;
  /**
   * Sample paths associated with truncation, capped by {@link TAG_SCAN_TRUNCATED_PATHS_MAX}.
   * Use trailing slashes for directories. Scan-wide depth, entry, and hit limits need not
   * name a path.
   */
  paths: string[];
  /**
   * Whether the scan read changed content or pruned cache entries. An unchanged result lets
   * the gather skip rewriting the persistent cache.
   */
  changed: boolean;
};

/**
 * Cached file tags keyed by the listing's modification time and size. Reuse listing metadata
 * to avoid an extra stat per file.
 *
 * This signature omits the inode and has millisecond timestamp precision. Same-length writes
 * within a millisecond can therefore leave stale hits. Files without a modification time are
 * not cached.
 */
export type CachedFile = { signature: string; hits: TagLineHit[] };

/**
 * Parsed file cache grouped by taskspace directory and relative path. Grouping lets
 * persistence import or export a taskspace's entries together.
 */
const fileCache = new Map<string, Map<string, CachedFile>>();

/**
 * Get or create a directory cache, mark it most recent, and evict older directories when the
 * limit is exceeded.
 */
function dirEntries(baseDir: string): Map<string, CachedFile> {
  // Only where the map can have grown. Eviction walks every key, and this is called once per
  // file parsed, so running it for a directory already held was a pass over the whole cache
  // per file for a map whose size had not changed.
  const known = fileCache.has(baseDir);
  const entries = touchOrCreate(fileCache, baseDir, () => new Map<string, CachedFile>());
  if (!known) evict(fileCache, TAG_CACHE_DIRS_MAX);
  return entries;
}

/**
 * Mark an existing directory cache as recent without creating an entry for an unreadable or
 * unscanned directory.
 */
const touchDir = (baseDir: string): void => touch(fileCache, baseDir);

/**
 * Evict old file entries once per scan. Running the full eviction pass per file would make
 * large scans quadratic.
 */
function evictFiles(baseDir: string, max: number): void {
  const entries = fileCache.get(baseDir);
  if (entries) evict(entries, max);
}

/** Clear parsed-file caches between tests that reuse temporary paths. */
export function clearTaskspaceTagCache(): void {
  fileCache.clear();
}

/**
 * Export a taskspace's parsed entries for persistence. Return undefined for an unscanned
 * directory, distinct from a scanned empty one.
 */
export function exportTaskspaceTagCache(baseDir: string): Record<string, CachedFile> | undefined {
  const entries = fileCache.get(baseDir);
  return entries ? Object.fromEntries(entries) : undefined;
}

/**
 * Seed cached files from persistence without replacing newer in-memory entries. Validate
 * signatures again before reuse. Do not create directory records from empty seeds, which
 * could make an unreadable directory appear successfully scanned.
 */
export function importTaskspaceTagCache(
  baseDir: string,
  entries: Record<string, CachedFile>,
): void {
  const incoming = Object.entries(entries);
  if (incoming.length === 0) return;
  const existing = dirEntries(baseDir);
  for (const [subPath, entry] of incoming) {
    if (!existing.has(subPath)) existing.set(subPath, entry);
  }
  // Apply cache limits to imported entries too, including files written by older builds or
  // edited externally.
  evict(existing, TAG_CACHE_FILES_MAX);
}

type FileTags =
  /** `parsed` when these bytes were read and scanned just now, rather than answered from the
   *  cache. Only the caller's `changed` flag reads it. */
  | { hits: TagLineHit[]; parsed?: boolean }
  | { skipped: Extract<TagScanTruncation, "budget" | "too-large" | "unreadable"> };

/** One file's tags, from the cache when the bytes have not changed since they were parsed. */
function fileTagHits(
  baseDir: string,
  subPath: string,
  entry: { size: number | null; modifiedAt: string | null },
  budget: Budget,
): FileTags {
  const size = entry.size ?? 0;
  // Null when the listing could not say when the file was last written, which leaves nothing
  // to tell one version of it from another. Such a file is read every time rather than
  // sharing a made-up key with every other file in the same position.
  const signature = entry.modifiedAt === null ? null : `${entry.modifiedAt}:${size}`;
  const entries = fileCache.get(baseDir);
  const cached = entries?.get(subPath);
  if (entries && signature !== null && cached?.signature === signature) {
    // Refresh recency on cache hits so unchanged files are retained ahead of older unused
    // entries.
    touch(entries, subPath);
    return { hits: cached.hits };
  }

  // Reject oversized files before charging the read budget because the file reader will not
  // open them. Report the size limit separately from unreadable content.
  if (size > TASKSPACE_FILE_BYTES_MAX) return { skipped: "too-large" };

  // Charge the budget before reading so over-budget files are never opened. Cache hits are
  // free, allowing later scans to reach additional files.
  if (size > budget.remaining) return { skipped: "budget" };
  budget.remaining -= size;

  let hits: TagLineHit[];
  try {
    hits = scanTagLines(readTaskspaceFile({ baseDir, subPath }).content);
  } catch {
    // Skip files that disappeared, became unreadable, or contain invalid text. Do not cache
    // failed reads.
    return { skipped: "unreadable" };
  }

  if (signature !== null) dirEntries(baseDir).set(subPath, { signature, hits });
  return { hits, parsed: true };
}

/** State for one walk. Named fields distinguish limits and counters that share a numeric type. */
type Scan = {
  baseDir: string;
  taskspaceId: string;
  budget: Budget;
  depthMax: number;
  /**
   * Maximum hits for this walk. The byte budget alone does not bound the number of tags. See
   * `TAG_SCAN_HITS_MAX`.
   */
  hitsMax: number;
  hits: TagHit[];
  truncated: Set<TagScanTruncation>;
  /** Every file path the walk reached, whether or not it read one. What {@link pruneStale}
   *  measures a completed directory against to find entries for files that are no longer
   *  there. */
  seen: Set<string>;
  /**
   * Directories whose listings were complete and whose returned entries were all visited. Use
   * these to identify stale files even if other subtrees were truncated. An empty path names
   * the root.
   */
  completed: Set<string>;
  /** The first few paths behind {@link Scan.truncated}, for a reader who has to go and find
   *  the file the scan is complaining about. See {@link TaskspaceTagScan.paths}. */
  paths: string[];
  /** Whether the scan read new file data that should be persisted. */
  parsed: boolean;
  /** Whether the taskspace root itself could not be listed. See
   *  {@link TaskspaceTagScan.missing}. */
  missing: boolean;
};

/**
 * Record at most {@link TAG_SCAN_TRUNCATED_PATHS_MAX} example paths for truncation
 * diagnostics.
 */
function noteTruncatedPath(scan: Scan, path: string): void {
  if (scan.paths.length < TAG_SCAN_TRUNCATED_PATHS_MAX) scan.paths.push(path);
}

// Use `Set<string>` so lookups accept arbitrary directory names rather than only the literals
// in `TAG_SCAN_SKIP_DIRS`.
const skipDirs = new Set<string>(TAG_SCAN_SKIP_DIRS);

function walk(scan: Scan, subPath: string, depth: number): void {
  if (depth > scan.depthMax) {
    scan.truncated.add("depth");
    return;
  }

  let listing;
  try {
    listing = listTaskspaceDirectory({ baseDir: scan.baseDir, subPath });
  } catch {
    // Report and skip unreadable directories. If the root itself cannot be listed, mark the
    // taskspace missing instead of partially scanned.
    if (depth === 0) {
      scan.missing = true;
      return;
    }
    scan.truncated.add("unreadable");
    // Mark the path as a directory so diagnostics distinguish it from an unreadable file.
    noteTruncatedPath(scan, `${subPath}/`);
    return;
  }
  // Cut short, so its entries are not all here and nothing below may conclude that a file it
  // did not see is gone. That is why this returns short of the `completed` mark at the foot
  // rather than merely recording a reason.
  if (listing.truncated) {
    scan.truncated.add("entries");
    noteTruncatedPath(scan, `${subPath || "."}/`);
  }

  for (const entry of listing.entries) {
    if (scan.budget.nodes <= 0) {
      scan.truncated.add("nodes");
      return;
    }
    // Stop traversal when the hit buffer is full to avoid reading content whose hits would be
    // discarded.
    if (scan.hits.length >= scan.hitsMax) {
      scan.truncated.add("hits");
      return;
    }
    scan.budget.nodes -= 1;
    const childPath = subPath ? `${subPath}/${entry.name}` : entry.name;

    if (entry.kind === "directory") {
      // Skipped directories are outside the scan's scope and do not count as truncation. See
      // `TAG_SCAN_SKIP_DIRS`.
      if (skipDirs.has(entry.name)) continue;
      walk(scan, childPath, depth + 1);
      continue;
    }
    // A symlink is not followed, and nothing else is a file to read.
    if (entry.kind !== "file") continue;

    scan.seen.add(childPath);
    const found = fileTagHits(scan.baseDir, childPath, entry, scan.budget);
    if ("skipped" in found) {
      scan.truncated.add(found.skipped);
      noteTruncatedPath(scan, childPath);
      continue;
    }
    if (found.parsed) scan.parsed = true;
    const taskspaceId = scan.taskspaceId;
    for (const { tag, line, excerpt } of found.hits) {
      // Check within each file to enforce the exact hit limit, even when one file contains
      // more tags than the scan can return.
      if (scan.hits.length >= scan.hitsMax) {
        scan.truncated.add("hits");
        break;
      }
      scan.hits.push({
        tag,
        source: { kind: "file", taskspaceId, path: childPath, line },
        excerpt,
      });
    }
  }

  // Mark the directory complete only after visiting every entry in a complete listing. All
  // budget and truncation exits return before this point.
  if (!listing.truncated) scan.completed.add(subPath);
}

/**
 * Parent directory of a taskspace-relative path. Use an empty string for the root, matching
 * {@link Scan.completed}.
 */
function parentDir(subPath: string): string {
  const cut = subPath.lastIndexOf("/");
  return cut === -1 ? "" : subPath.slice(0, cut);
}

/**
 * Prune unseen cached files only when their parent directory was fully listed. Preserve
 * entries from incomplete directories because absence from a partial scan does not establish
 * deletion.
 */
function pruneStale(baseDir: string, seen: Set<string>, completed: Set<string>): boolean {
  const entries = fileCache.get(baseDir);
  if (!entries) return false;

  let pruned = false;
  for (const subPath of entries.keys()) {
    if (seen.has(subPath)) continue;
    // Keep entries whose directories were not fully listed. An incomplete scan cannot
    // establish that a file was deleted.
    if (!completed.has(parentDir(subPath))) continue;
    entries.delete(subPath);
    pruned = true;
  }
  return pruned;
}

/**
 * Scan a taskspace's tags with their source files and lines. Return no hits and `missing` for
 * deleted, moved, or unreadable taskspaces so one unavailable taskspace does not fail the
 * page. See {@link TaskspaceTagScan.missing}.
 */
export function scanTaskspaceTags(
  baseDir: string,
  taskspaceId: string,
  limits: TaskspaceScanLimits = {},
  pool?: ScanPool,
): TaskspaceTagScan {
  // Touch the directory before scanning so a cache-only scan still refreshes recency.
  touchDir(baseDir);

  // Apply the smaller of the taskspace limit and remaining workspace budget. Report budget
  // truncation when no allowance remains.
  const bytes = Math.min(limits.bytes ?? TAG_SCAN_TOTAL_BYTES_MAX, pool?.bytes ?? Infinity);
  const nodes = Math.min(limits.nodes ?? TAG_SCAN_NODES_MAX, pool?.nodes ?? Infinity);

  const scan: Scan = {
    baseDir,
    taskspaceId,
    budget: { remaining: bytes, nodes },
    depthMax: limits.depth ?? TAG_SCAN_DEPTH_MAX,
    hitsMax: limits.hits ?? TAG_SCAN_HITS_MAX,
    hits: [],
    truncated: new Set(),
    seen: new Set(),
    completed: new Set(),
    paths: [],
    parsed: false,
    missing: false,
  };

  walk(scan, "", 0);

  // What this taskspace actually spent, not what it was allowed. A cache hit is charged for
  // nothing, so a warm gather leaves the pool untouched and a workspace being read again and
  // again never runs into this ceiling at all.
  if (pool) {
    pool.bytes -= bytes - scan.budget.remaining;
    pool.nodes -= nodes - scan.budget.nodes;
  }

  const pruned = pruneStale(baseDir, scan.seen, scan.completed);
  // Cap the cache after pruning to bound entries from taskspaces too large for a scan to
  // finish.
  evictFiles(baseDir, limits.files ?? TAG_CACHE_FILES_MAX);

  return {
    hits: scan.hits,
    truncated: [...scan.truncated],
    missing: scan.missing,
    paths: scan.paths,
    changed: scan.parsed || pruned,
  };
}
