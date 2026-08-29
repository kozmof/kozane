import {
  TAG_CACHE_DIRS_MAX,
  TAG_SCAN_DEPTH_MAX,
  TAG_SCAN_HITS_MAX,
  TAG_SCAN_NODES_MAX,
  TAG_SCAN_SKIP_DIRS,
  TAG_SCAN_TOTAL_BYTES_MAX,
  TAG_SCAN_WORKSPACE_BYTES_MAX,
  TAG_SCAN_WORKSPACE_NODES_MAX,
  TASKSPACE_FILE_BYTES_MAX,
} from "../constants.js";
import { scanTagLines, type TagLineHit } from "../tag.js";
import type { TagHit, TagScanTruncation } from "../types.js";
import { evict, touch, touchOrCreate } from "./lru.js";
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
 *
 * One rule is this walk's own, because it is the only one that reads a whole tree at once
 * rather than the directory a user asked for: {@link TAG_SCAN_SKIP_DIRS} is not descended
 * into. See the note there for what that is worth — without it a working tree's generated
 * output spends the budget before the walk reaches anything anyone wrote.
 */

/** What is left to spend on this scan. The same running-totals shape, and the same reasoning,
 *  as `Budget` in `taskspace-snapshot.ts`: the boundary functions read one directory and one
 *  file at a time, so a budget can only be spent, not computed up front. */
type Budget = { remaining: number; nodes: number };

/** What one taskspace's walk may spend, each defaulting to the constant it is named after.
 *  Overridable so a test can reach a limit without putting twenty thousand entries on disk. */
export type TaskspaceScanLimits = { bytes?: number; nodes?: number; depth?: number; hits?: number };

/** What a whole gather may spend, across every taskspace in it. See {@link ScanPool}. */
export type GatherScanLimits = { workspaceBytes?: number; workspaceNodes?: number };

/**
 * Both, for the one caller that sets them together — `loadTagIndex` takes a single `limits`
 * and hands each half to the function that spends it.
 *
 * Named halves rather than one flat bag of five optional numbers, which is what this was.
 * Every field was optional and the two audiences were told apart only by a prefix, so
 * {@link createScanPool} silently ignored three of them and {@link scanTaskspaceTags}
 * silently ignored the other two — with nothing in either signature to say which it read.
 * Each now asks for the half it spends; passing the whole thing still satisfies both.
 */
export type ScanLimits = TaskspaceScanLimits & GatherScanLimits;

/**
 * What is left to spend across a whole gather — one pool, passed to every taskspace in it.
 *
 * Mutable and shared, for the reason {@link Budget} is: what a taskspace costs is only known
 * once it has been walked, so the loop can subtract but cannot divide up front. A taskspace
 * takes the smaller of its own ceiling and what is left here, which is what keeps the first
 * one in the list from spending the gather on itself.
 *
 * See {@link TAG_SCAN_WORKSPACE_BYTES_MAX} for why a per-taskspace ceiling was not enough on
 * its own.
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
   * Whether this scan learned anything the cache did not already hold — a file read for the
   * first time or read again after a change, or a stale entry dropped.
   *
   * False is the ordinary case for a taskspace nobody has touched, and is what lets
   * `loadTagIndex` skip rewriting a cache file that would come back byte-for-byte the same.
   */
  changed: boolean;
};

/**
 * One file's tags as they were last read, kept against the identity of the bytes they came
 * from. `signature` is `${modifiedAt}:${size}` — both of which {@link listTaskspaceDirectory}
 * already returns, from an `lstat` the walk does whether or not there is a cache. So
 * revalidating a file costs no syscall of its own: a scan of an untouched tree is all walk
 * and no reads, and only a file that actually changed is read and parsed again.
 *
 * Weaker than `fileSignature` in two ways, both from taking what the listing already has
 * rather than paying for a `stat` of its own. There is no inode, so a file *replaced* by
 * rename — which is how editors and Kozane's own writers save — is caught by its mtime rather
 * than outright. And `modifiedAt` is an ISO string, so the resolution is a millisecond where
 * `fileSignature` reports nanoseconds. Two writes of the same length inside one millisecond
 * are therefore indistinguishable here.
 *
 * Out of reach of a person editing a file, which is what this is for, and the cost of being
 * wrong is a stale entry rather than a wrong answer anywhere durable: the tag index is
 * rebuilt from it, not trusted as a record. If it ever needs closing, `fileSignature` closes
 * both halves for one extra `stat` per file.
 *
 * A file whose `modifiedAt` is null has no signature at all, and so is never cached and never
 * answered from the cache — see {@link fileTagHits}. Composing one out of the null read as a
 * signature like any other, so every such file in a taskspace shared the one key `null:0` and
 * the first of them answered for all the rest.
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

/**
 * One directory's entries, created on first sight, and moved to the end of the map either
 * way — which is what makes insertion order least-recently-used.
 *
 * Eviction happens here rather than on a timer because here is where the map grows. It was
 * missing entirely: pruning is per directory — {@link pruneStale} drops files that are gone
 * from one that was walked — so a taskspace deleted, re-pathed, or simply not looked at
 * again kept every file it had ever parsed for the life of the server, and a long-lived
 * `kozane open` grew without bound over a workspace whose taskspaces come and go.
 *
 * The directory just touched is never the one evicted, since it is at the end; an evicted one
 * costs a re-read the next time it is scanned, and nothing else.
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
 * Marks a directory as the most recently used, without creating one for a directory this
 * process does not hold.
 *
 * Separate from {@link dirEntries} because a scan that answers entirely from the cache writes
 * nothing, and so would never touch the map that is about to evict it — the taskspace nobody
 * has edited is exactly the one worth keeping. Creating on the way past instead would leave
 * an empty record for a taskspace whose directory could not even be listed, and
 * {@link exportTaskspaceTagCache} would then report it as scanned-and-empty.
 */
const touchDir = (baseDir: string): void => touch(fileCache, baseDir);

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
 *
 * Seeding nothing creates nothing, which is the same distinction {@link touchDir} keeps and
 * for the same reason. A store holding `{}` for a directory — what a taskspace scanned and
 * found empty of readable files writes — would otherwise create an empty record here, and if
 * that directory has since been deleted or made unreadable the walk creates no record of its
 * own, so {@link exportTaskspaceTagCache} would answer `{}` rather than `undefined` and the
 * caller would keep the entry instead of dropping it. An empty record is cheap; a record
 * that says "scanned, and empty" about a directory nothing could scan is not.
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
  const cached = fileCache.get(baseDir)?.get(subPath);
  if (signature !== null && cached?.signature === signature) return { hits: cached.hits };

  // Refused here rather than by the read below, because the read is not what it would cost.
  // `readTaskspaceFile` turns a file past the per-file cap away without opening it, so
  // charging for one and *then* being refused spends budget on bytes nobody ever looked at —
  // and a single large asset beside the notes was enough to spend the whole of it and leave
  // the text files after it reported as `"budget"`.
  //
  // Its own reason rather than `"unreadable"`, which is what this said. A file over the cap
  // is a file this scan declines to open, not one that failed: reported as unreadable, a
  // taskspace holding one video told the reader "some files could not be read", which
  // describes something being wrong with their taskspace rather than with their file.
  if (size > TASKSPACE_FILE_BYTES_MAX) return { skipped: "too-large" };

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
    // Not UTF-8 text, unreadable, or gone since the listing named it. The listing that named
    // it ran moments earlier and is not a lease on what is still there — the same
    // degrade-and-carry-on `buildFileNode` does, and for the same reasons. Not cached: a file
    // that could not be read has no signature worth remembering.
    return { skipped: "unreadable" };
  }

  if (signature !== null) dirEntries(baseDir).set(subPath, { signature, hits });
  return { hits, parsed: true };
}

/**
 * One walk's running state. A record rather than eight positional parameters, which is what
 * this was: four of them were numbers, two of those were a depth and a depth ceiling next to
 * each other, and a call could be got wrong without a type error to say so.
 */
type Scan = {
  baseDir: string;
  taskspaceId: string;
  budget: Budget;
  depthMax: number;
  /** How many hits this walk will carry. See `TAG_SCAN_HITS_MAX`: the byte budget bounds
   *  what is read and says nothing about how many tags reading it produces. */
  hitsMax: number;
  hits: TagHit[];
  truncated: Set<TagScanTruncation>;
  /** Every file path the walk reached, whether or not it read one. What {@link pruneStale}
   *  measures a complete walk against to find entries for files that are no longer there. */
  seen: Set<string>;
  /** Whether this walk read a file it did not already hold. What decides whether there is
   *  anything new to persist — see `openTagCache` in `tag-index.ts`. */
  parsed: boolean;
};

// `Set<string>` explicitly: `TAG_SCAN_SKIP_DIRS` is `as const`, so the names stay a literal
// union for anything that wants to enumerate them, and inferring that union here would leave
// a set that cannot be asked about an arbitrary directory name.
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
    // A directory the server user cannot read, one gone since it was named, or — reaching
    // this as the first call of the walk — a taskspace whose directory has been deleted or
    // moved since the row naming it was written. One such taskspace must not take a page
    // load down with it, so it is reported and skipped.
    scan.truncated.add("unreadable");
    return;
  }
  if (listing.truncated) scan.truncated.add("entries");

  for (const entry of listing.entries) {
    if (scan.budget.nodes <= 0) {
      scan.truncated.add("nodes");
      return;
    }
    // Full, so there is nothing left for the rest of the tree to be read *into*. Returning
    // unwinds the same way the nodes budget does — each enclosing loop meets this on its
    // next entry — and stops the walk from spending bytes and syscalls producing hits that
    // would only be dropped.
    if (scan.hits.length >= scan.hitsMax) {
      scan.truncated.add("hits");
      return;
    }
    scan.budget.nodes -= 1;
    const childPath = subPath ? `${subPath}/${entry.name}` : entry.name;

    if (entry.kind === "directory") {
      // Not a truncation, the same as a dot-entry is not: this is the tree as this scan
      // defines it, not a tree it ran out of room to finish. See TAG_SCAN_SKIP_DIRS.
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
      continue;
    }
    if (found.parsed) scan.parsed = true;
    const taskspaceId = scan.taskspaceId;
    for (const { tag, line, excerpt } of found.hits) {
      // Here as well as at the top of the loop, so the ceiling is exact rather than
      // per-file: one generated file can hold more tags on its own than the whole scan
      // carries, and checking only between files would let it through in full.
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
}

/**
 * Forgets cached files this walk did not reach.
 *
 * Only for a walk that finished, which is what the `truncated` guard in the caller is for: a
 * scan that stopped at a budget did not reach directories that are still there, and treating
 * "not seen" as "no longer there" would throw away good entries and re-read them next time —
 * the opposite of what the cache is for.
 *
 * Without this the map only ever grew. A file renamed, deleted, or moved left its entry
 * behind for the life of the process, and `exportTaskspaceTagCache` wrote every one of them
 * to disk, so a long-lived server against a working tree accumulated the tags of every file
 * that had ever been there.
 */
function pruneStale(baseDir: string, seen: Set<string>): boolean {
  const entries = fileCache.get(baseDir);
  if (!entries) return false;

  let pruned = false;
  for (const subPath of entries.keys()) {
    if (seen.has(subPath)) continue;
    entries.delete(subPath);
    pruned = true;
  }
  return pruned;
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
  limits: TaskspaceScanLimits = {},
  pool?: ScanPool,
): TaskspaceTagScan {
  // Before the walk, so that a taskspace answered entirely from the cache — which writes
  // nothing, and so touches the map nowhere else — is still the most recently used.
  touchDir(baseDir);

  // The smaller of this taskspace's own ceiling and what the gather has left. Both bind: one
  // taskspace cannot cost more than its share, and the taskspaces together cannot cost more
  // than the page. A pool run down to nothing leaves a scan that reads no file and reports
  // `"budget"`, which is the true answer — those files were not read.
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
    parsed: false,
  };

  walk(scan, "", 0);

  // What this taskspace actually spent, not what it was allowed. A cache hit is charged for
  // nothing, so a warm gather leaves the pool untouched and a workspace being read again and
  // again never runs into this ceiling at all.
  if (pool) {
    pool.bytes -= bytes - scan.budget.remaining;
    pool.nodes -= nodes - scan.budget.nodes;
  }

  const complete = scan.truncated.size === 0;
  const pruned = complete && pruneStale(baseDir, scan.seen);

  return { hits: scan.hits, truncated: [...scan.truncated], changed: scan.parsed || pruned };
}
