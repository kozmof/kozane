import { TAG_SCAN_DEPTH_MAX, TAG_SCAN_NODES_MAX, TAG_SCAN_TOTAL_BYTES_MAX } from "../constants.js";
import { scanTagLines, type TagLineHit } from "../tag.js";
import type { TagHit } from "../types.js";
import { listTaskspaceDirectory, readTaskspaceFile } from "./taskspace-files.js";

/**
 * The tags written in the files of one taskspace.
 *
 * The file half of tagging, and the half that cannot be a database read: a taskspace is an
 * ordinary directory on disk that anything may write to, so the only way to know what tags
 * are in it is to look. Everything below is about making looking cheap enough to do while
 * someone waits.
 *
 * Built on {@link listTaskspaceDirectory} and {@link readTaskspaceFile}, the same two
 * functions the live `/files` and `/file` endpoints hold a request to. Every boundary they
 * enforce therefore applies here without being restated: dot-entries hidden and never
 * recursed into, so a `.git` and an `.env` are not scanned; symlinks reported and never
 * followed, so the walk cannot leave the taskspace; the 1 MB per-file cap; and strict UTF-8,
 * so a binary is refused rather than parsed as if it were text.
 */

/** What is left to spend on this scan. The same running-totals shape, and the same reasoning,
 *  as `Budget` in `taskspace-snapshot.ts`: the boundary functions read one directory and one
 *  file at a time, so a budget can only be spent, not computed up front. */
type Budget = { remaining: number; nodes: number };

/** Ceilings for one call, each defaulting to the constant it is named after. Overridable so a
 *  test can reach a limit without putting twenty thousand entries on disk to do it. */
export type ScanLimits = { bytes?: number; nodes?: number; depth?: number };

/**
 * Why a scan is not the whole taskspace. Its own vocabulary rather than
 * `TaskspaceTruncation`, which enumerates the limits the *export walk* stops at: this
 * walk has a reason that one does not — `"budget"`, a file left unread because the scan's
 * byte ceiling was already spent — and the export has nodes to hang a per-file reason on
 * where this has only the one answer for the whole taskspace.
 *
 * Each is a distinct thing to be told. A file that ran past the budget and one that could
 * not be read at all both produce no tags, and neither is "there are no tags in this file".
 */
export type TagScanTruncation = "entries" | "depth" | "nodes" | "budget" | "unreadable";

export type TaskspaceTagScan = {
  hits: TagHit[];
  /**
   * The limits this scan stopped at, empty when it read the whole taskspace. A tag index
   * that says nothing about a taskspace it only half-read is telling the user their tag is
   * not there when it may well be.
   */
  truncated: TagScanTruncation[];
};

/**
 * One file's tags as they were last read, kept against the identity of the bytes they came
 * from. `signature` is `${modifiedAt}:${size}` — both of which {@link listTaskspaceDirectory}
 * already returns, from an `lstat` the walk does whether or not there is a cache. So
 * revalidating a file costs no syscall of its own: a scan of an untouched tree is all walk
 * and no reads, and only a file that actually changed is read and parsed again.
 *
 * The same gap `fileSignature` documents for its own mtime-and-size half applies, minus the
 * inode: two writes of the same length inside one filesystem timestamp tick are
 * indistinguishable. Out of reach of a person editing a file, which is what this is for. If
 * it ever needs closing, `fileSignature` closes it for one extra `stat` per file.
 */
export type CachedFile = { signature: string; hits: TagLineHit[] };

/**
 * Files parsed in this process: taskspace directory, then path within it. Lives for the life
 * of the server — the entries are small, a path, a signature, and the tags of one file, and a
 * taskspace whose files are re-read on every visit is the cost this exists to remove.
 *
 * Nested rather than keyed by a joined string so that one taskspace's entries can be handed
 * out and taken back whole; see {@link exportTaskspaceTagCache}.
 */
const fileCache = new Map<string, Map<string, CachedFile>>();

/** Forgets every cached file. For tests, which write a temporary directory, delete it, and
 *  write a fresh one at a path the first may well have used — the same reason
 *  `clearTaskspaceFileTreeCache` exists. */
export function clearTaskspaceTagCache(): void {
  fileCache.clear();
}

/**
 * One taskspace's parsed files, for a caller that keeps them somewhere this process cannot
 * reach — `tag-cache.ts` writes them to disk, so the next process starts warm instead of
 * re-reading every file to learn what it already knew.
 *
 * Undefined for a directory nothing has scanned, which is different from one scanned and
 * found empty.
 */
export function exportTaskspaceTagCache(baseDir: string): Record<string, CachedFile> | undefined {
  const entries = fileCache.get(baseDir);
  return entries ? Object.fromEntries(entries) : undefined;
}

/**
 * Seeds one taskspace's files from such a store.
 *
 * Safe against a store that has gone stale in the meantime, and not by being careful here:
 * every entry is still checked against the file's current signature before it is used, so
 * seeding a wrong or ancient entry costs one re-read and never a wrong answer. Existing
 * entries win, being at worst as old as these and at best fresher.
 */
export function importTaskspaceTagCache(
  baseDir: string,
  entries: Record<string, CachedFile>,
): void {
  const existing = fileCache.get(baseDir) ?? new Map<string, CachedFile>();
  for (const [subPath, entry] of Object.entries(entries)) {
    if (!existing.has(subPath)) existing.set(subPath, entry);
  }
  fileCache.set(baseDir, existing);
}

type FileTags =
  | { hits: TagLineHit[] }
  | { skipped: Extract<TagScanTruncation, "budget" | "unreadable"> };

/** One file's tags, from the cache when the bytes have not changed since they were parsed. */
function fileTagHits(
  baseDir: string,
  subPath: string,
  signature: string,
  budget: Budget,
  size: number,
): FileTags {
  const cached = fileCache.get(baseDir)?.get(subPath);
  if (cached?.signature === signature) return { hits: cached.hits };

  // Charged before the read rather than after, so a file the budget cannot afford is not
  // read at all. A cache hit above is deliberately free: those bytes were paid for once,
  // and charging for them again would make a repeat scan of an unchanged taskspace run out
  // of budget at exactly the point the first one did.
  if (size > budget.remaining) return { skipped: "budget" };
  budget.remaining -= size;

  let hits: TagLineHit[];
  try {
    hits = scanTagLines(readTaskspaceFile({ baseDir, subPath }).content);
  } catch {
    // A file too large, not UTF-8 text, unreadable, or gone since the listing named it. The
    // listing that named it ran moments earlier and is not a lease on what is still there —
    // the same degrade-and-carry-on `buildFileNode` does, and for the same reasons. Not
    // cached: a file that could not be read has no signature worth remembering.
    return { skipped: "unreadable" };
  }

  const entries = fileCache.get(baseDir) ?? new Map<string, CachedFile>();
  entries.set(subPath, { signature, hits });
  fileCache.set(baseDir, entries);
  return { hits };
}

function walk(
  baseDir: string,
  taskspaceId: string,
  subPath: string,
  budget: Budget,
  depth: number,
  depthMax: number,
  hits: TagHit[],
  truncated: Set<TagScanTruncation>,
): void {
  if (depth > depthMax) {
    truncated.add("depth");
    return;
  }

  let listing;
  try {
    listing = listTaskspaceDirectory({ baseDir, subPath });
  } catch {
    // A directory the server user cannot read, one gone since it was named, or — reaching
    // this as the first call of the walk — a taskspace whose directory has been deleted or
    // moved since the row naming it was written. One such taskspace must not take a page
    // load down with it, so it is reported and skipped.
    truncated.add("unreadable");
    return;
  }
  if (listing.truncated) truncated.add("entries");

  for (const entry of listing.entries) {
    if (budget.nodes <= 0) {
      truncated.add("nodes");
      return;
    }
    budget.nodes -= 1;
    const childPath = subPath ? `${subPath}/${entry.name}` : entry.name;

    if (entry.kind === "directory") {
      walk(baseDir, taskspaceId, childPath, budget, depth + 1, depthMax, hits, truncated);
      continue;
    }
    // A symlink is not followed, and nothing else is a file to read.
    if (entry.kind !== "file") continue;

    const signature = `${entry.modifiedAt}:${entry.size}`;
    const found = fileTagHits(baseDir, childPath, signature, budget, entry.size ?? 0);
    if ("skipped" in found) {
      truncated.add(found.skipped);
      continue;
    }
    for (const { tag, line, excerpt } of found.hits) {
      hits.push({ tag, source: { kind: "file", taskspaceId, path: childPath, line }, excerpt });
    }
  }
}

/**
 * Every tag in one taskspace, with the file and line it was written on.
 *
 * Never throws. A taskspace whose directory has been deleted, moved, or made unreadable
 * comes back as no hits and an `"unreadable"` truncation, because a tag page listing five
 * taskspaces must not become a 500 over one of them.
 */
export function scanTaskspaceTags(
  baseDir: string,
  taskspaceId: string,
  limits: ScanLimits = {},
): TaskspaceTagScan {
  const budget: Budget = {
    remaining: limits.bytes ?? TAG_SCAN_TOTAL_BYTES_MAX,
    nodes: limits.nodes ?? TAG_SCAN_NODES_MAX,
  };
  const hits: TagHit[] = [];
  const truncated = new Set<TagScanTruncation>();

  walk(baseDir, taskspaceId, "", budget, 0, limits.depth ?? TAG_SCAN_DEPTH_MAX, hits, truncated);

  return { hits, truncated: [...truncated] };
}
