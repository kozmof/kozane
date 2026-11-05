import { get as getTags } from "../../services/tags.js";
import { workspaceServiceContext } from "./service-context.js";
import type { AnyDB } from "../../db/client.js";
import { getAllTaskspaces, getTaskspacesInNamespace } from "../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../db/internal/config.js";
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
export type {
  TagIndex,
  TagIndexTruncation,
  TagIndexTaskspace,
  TagIndexTaskspaces,
} from "../../services/tags.js";
import type { TagIndex, TagIndexTruncation, TagIndexTaskspace } from "../../services/tags.js";

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
  // Use the same workspace root for persistent caching and taskspace scanning.
  // Without a root, skip both.
  const store =
    cache && root
      ? openTagCache({ root, dbUrl: cache.dbUrl, ...(namespaceId && { namespaceId }) })
      : null;

  const stored = store?.cards();
  const cards = stored ?? (await getTags(db, workspaceServiceContext(), namespaceId));
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
    const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
    if (!baseDir) continue;
    // Yield between taskspaces so queued requests can run. Individual walks remain
    // synchronous, and a single-taskspace gather needs no yield.
    if (scannedAny) await yieldToEventLoop();
    scannedAny = true;
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
