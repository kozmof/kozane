import type { AnyDB } from "../../db/client.js";
import { getCardTagHits, type CardTagHits } from "../../db/api/tag.js";
import { getAllTaskspaces, getTaskspacesInNamespace } from "../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../db/internal/config.js";
import type { TagHit, TagScanTruncation } from "../types.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import { createScanPool, scanTaskspaceTags, type ScanLimits } from "./taskspace-tags.js";
import { openTagCache } from "./tag-cache.js";

/**
 * Yield to the event loop between synchronous scans. Use `setImmediate` so pending I/O can
 * run, with `setTimeout` as a fallback for test environments that lack it. A resolved promise
 * would only yield to microtasks.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * Reasons a taskspace scan stopped early. Omit fully scanned taskspaces from this list.
 * Resolve taskspace names through {@link TagIndex.taskspaces}.
 */
export type TagIndexTruncation = {
  taskspaceId: string;
  reasons: TagScanTruncation[];
  /** A few of the paths the reasons are about, relative to the taskspace, or empty where
   *  none of them names a file. See `TaskspaceTagScan.paths`. */
  paths: string[];
};

/**
 * Name and namespace for a scanned taskspace. Keep them together because readers use both to
 * label file hits and link to boards. A null namespace identifies an unplaced taskspace shown
 * on every board.
 */
export type TagIndexTaskspace = { name: string; namespaceId: string | null };

/** Scanned taskspace metadata keyed by ID, with optional lookup values. */
export type TagIndexTaskspaces = Record<string, TagIndexTaskspace | undefined>;

export type TagIndex = {
  /** Card and file hits share one list. `hit.source.kind` identifies their source. */
  hits: TagHit[];
  /** Cached partition/namespace/change-day dimensions for every card carrying a hit. */
  cardData: CardTagHits["cardData"];
  /** Which namespace each card carrying a hit belongs to. See `CardTagHits`. */
  cardNamespaces: Record<string, string | undefined>;
  /**
   * Metadata for taskspaces considered by this gather. Return an empty map when file scanning
   * is disabled, and allow missing lookups in page-filtered or older data.
   *
   * Reuse gathered metadata so readers do not fetch or publish unrelated taskspace names.
   */
  taskspaces: TagIndexTaskspaces;
  truncated: TagIndexTruncation[];
  /**
   * IDs of taskspaces whose root directories could not be opened. Keep these separate from
   * partial scans so readers can suggest checking or cleaning up the records. Resolve names
   * through {@link TagIndex.taskspaces}.
   */
  missing: string[];
  /**
   * Whether card scanning stopped at {@link TAG_CARD_HITS_MAX}. If true, the hits contain
   * only part of the workspace's card tags. Display this alongside the per-taskspace notices
   * in {@link TagIndex.truncated}.
   */
  cardsTruncated: boolean;
};

type LoadTagIndex = {
  db: AnyDB;
  /**
   * Optional namespace filter. Include that namespace's cards and visible taskspaces, or the
   * entire workspace when omitted.
   */
  namespaceId?: string;
  /**
   * Whether to scan taskspace files. Live pages enable scanning. Static exports enable it
   * only with `--include-scoped-files`, because file hits expose paths and content in
   * exported page data. Apply this restriction here before serializing the data.
   */
  includeFiles: boolean;
  /**
   * Workspace root used to resolve taskspace paths. Discover it from the environment when
   * omitted. The CLI passes the root already found by `requireWorkspace()`.
   */
  root?: string | null;
  /** Scan limit overrides used by tests. */
  limits?: ScanLimits;
  /**
   * Optional database identity for persistent caching. Omit it to gather afresh. Store the
   * cache under the gather's workspace root so source data and cached files cannot name
   * different workspaces.
   */
  cache?: { dbUrl: string };
};

/**
 * Gather card and file tags for the page and CLI through one shared reader.
 * Namespace-filtered gathers include that namespace's taskspaces and unplaced taskspaces,
 * matching the board.
 */
export async function loadTagIndex({
  db,
  namespaceId,
  includeFiles,
  root = getWorkspaceRoot(),
  limits,
  cache,
}: LoadTagIndex): Promise<TagIndex> {
  // No root, nowhere to keep it. That is the same condition the file walk below stops at,
  // and reading it off one value is what keeps the cache and the walk talking about one
  // workspace.
  const store =
    cache && root
      ? openTagCache({ root, dbUrl: cache.dbUrl, ...(namespaceId && { namespaceId }) })
      : null;

  const stored = store?.cards();
  const cards = stored ?? (await getCardTagHits({ db, namespaceId }));
  // A card set that had to be queried is a card set the stored file does not hold.
  let changed = !stored;
  const hits = [...cards.hits];
  const { cardData, cardNamespaces } = cards;
  const taskspaces: Record<string, TagIndexTaskspace> = {};
  const truncated: TagIndexTruncation[] = [];
  const missing: string[] = [];

  // No workspace root means no directory to resolve a taskspace against. The cards are still
  // a complete answer about cards, so the index is served rather than refused.
  if (!includeFiles || !root) {
    store?.save({ cards, changed });
    return {
      hits,
      cardData,
      cardNamespaces,
      taskspaces,
      truncated,
      missing,
      cardsTruncated: cards.truncated,
    };
  }

  const rows = namespaceId
    ? await getTaskspacesInNamespace({ db, namespaceId })
    : await getAllTaskspaces({ db });

  const scanned: { baseDir: string; changed: boolean }[] = [];
  // Share a workspace-wide scan budget in addition to each taskspace's limit so total
  // synchronous work is bounded.
  const pool = createScanPool(limits?.gather);
  let scannedAny = false;
  for (const taskspace of rows) {
    if (!taskspace.path) continue;
    // Yield between taskspaces so queued requests can run. Individual walks remain
    // synchronous, and a single-taskspace gather needs no yield.
    if (scannedAny) await yieldToEventLoop();
    scannedAny = true;
    const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
    // Load cached file entries before scanning. The walk still validates signatures but can
    // avoid rereading unchanged files.
    store?.seedFiles(baseDir);
    const scan = scanTaskspaceTags(baseDir, taskspace.id, limits?.taskspace, pool);
    scanned.push({ baseDir, changed: scan.changed });
    changed ||= scan.changed;
    // Record every visited taskspace so notices can name it even when it yields no hits.
    taskspaces[taskspace.id] = { name: taskspace.name, namespaceId: taskspace.namespaceId };
    // Append hits individually to avoid the engine's function-argument limit for large
    // arrays.
    for (const hit of scan.hits) hits.push(hit);
    if (scan.truncated.length > 0)
      truncated.push({
        taskspaceId: taskspace.id,
        reasons: scan.truncated,
        paths: scan.paths,
      });
    // Track missing taskspaces separately from partial scans. See `TagIndex.missing`.
    if (scan.missing) missing.push(taskspace.id);
  }

  store?.save({ cards, scanned, changed });
  return {
    hits,
    cardData,
    cardNamespaces,
    taskspaces,
    truncated,
    missing,
    cardsTruncated: cards.truncated,
  };
}
