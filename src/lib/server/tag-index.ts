import type { AnyDB } from "../../db/client.js";
import { getCardTagHits } from "../../db/api/tag.js";
import { getAllTaskspaces, getTaskspacesInProject } from "../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../db/internal/config.js";
import type { TagHit, TagScanTruncation } from "../types.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import { createScanPool, scanTaskspaceTags, type ScanLimits } from "./taskspace-tags.js";
import { openTagCache, scopeKey } from "./tag-cache.js";

/**
 * What one taskspace could not tell us, and which one it was. Empty for a taskspace read
 * whole, and absent from the list entirely rather than present with nothing to say.
 *
 * The id alone, because {@link TagIndex.taskspaces} names it. It carried a `taskspaceName`
 * of its own until the index started carrying every walked taskspace: a truncation can only
 * be raised about a taskspace this gather walked, and a walked taskspace is in that record,
 * so the name was a second copy of an entry the same return value already held.
 */
export type TagIndexTruncation = {
  taskspaceId: string;
  reasons: TagScanTruncation[];
};

/**
 * A taskspace this gather walked: what to call it, and which board it belongs to.
 *
 * Both, together, because both are joined against the same id and by the same callers — the
 * terminal and the page each label a file row with the name and send it back to a board with
 * the project. Two records keyed alike would be two chances to hold one and not the other.
 *
 * `projectId` is null for a taskspace belonging to no project. Null is not missing data: an
 * unplaced taskspace is drawn on every board (see `getTaskspacesInProject`), so a hit in one
 * has no single board to be sent back to.
 */
export type TagIndexTaskspace = { name: string; projectId: string | null };

export type TagIndex = {
  /** Card hits and file hits in one list, which is the point: a tag is a tag whichever it
   *  was written in, and `hit.source.kind` is the only thing that separates them. */
  hits: TagHit[];
  /** Which project each card carrying a hit belongs to. See `CardTagHits`. */
  cardProjects: Record<string, string>;
  /**
   * Every taskspace this gather walked, by id — not every taskspace there is.
   *
   * The set the gather looked at is exactly the set a reader of it needs to name: a file hit
   * can only have come from one of these, and so can a truncation. Both callers were joining
   * a name from a taskspace list of their own, which is a second read of rows this already
   * had in hand — and the page's list was the whole workspace's, so it published the names of
   * taskspaces its own answer never mentioned.
   *
   * Empty when no file was scanned at all, which is what `includeFiles: false` means. That is
   * what keeps a static export from naming a taskspace it carries no hit from, without the
   * page needing a second rule to say so.
   */
  taskspaces: Record<string, TagIndexTaskspace>;
  truncated: TagIndexTruncation[];
};

type LoadTagIndex = {
  db: AnyDB;
  /**
   * Narrows the index to one project's cards, and to the taskspaces that project's board
   * draws. Omitted, every card and every taskspace in the workspace is read — which is what
   * the tag index page does when its URL names no project.
   */
  projectId?: string;
  /**
   * Whether taskspace files are scanned at all.
   *
   * The live page passes `true`. A static export passes `false` unless built with
   * `--include-scoped-files`, for the reason the note on `includeScopes` in
   * `project-snapshot.ts` gives at more length: a file hit carries a path inside the
   * workspace *and* a line of that file's content, and page data baked into a publishable
   * export is readable via view-source however the UI draws it. So it has to be decided
   * here, not in the component.
   */
  includeFiles: boolean;
  /**
   * The workspace root a taskspace's stored path is resolved against. Omitted, it is
   * discovered from the environment, which is how a server route gets one. The CLI passes
   * the root `requireWorkspace()` already found, for the reason `getUiConfigForRoot` gives:
   * same directory either way, and passing it means the command does not rest on the two
   * ways of arriving at it agreeing.
   */
  root?: string | null;
  /** Passed through to each taskspace scan. For tests; nothing in the app sets it. */
  limits?: ScanLimits;
  /**
   * The database to validate a persisted gather against, where the gather is to be kept at
   * all.
   *
   * Opt-in rather than automatic. The page and the CLI pass it; a caller that says nothing
   * gathers afresh, which is what the existing tests do and what any caller wanting a
   * guaranteed-cold read can rely on.
   *
   * The directory it is kept in is `root` above, and is deliberately not repeated here. It
   * was, and that made two workspace roots on one call with nothing to hold them together:
   * a caller could seed this process's file entries from one workspace's cache while walking
   * another's taskspaces, and both fields would type-check.
   */
  cache?: { dbUrl: string };
};

/**
 * Every tag in a workspace, or in one project of it: the ones on cards and the ones in
 * taskspace files.
 *
 * The one read behind both callers — the tag index page and `kozane tag list|show` — for the
 * same reason `loadProjectSnapshot` is one read behind the page load and the poll: two
 * copies of "gather the tags" is two answers to the same question, and the CLI quietly
 * disagreeing with the page about what a tag holds is a bug nobody would think to look for.
 *
 * Narrowed to a project, the taskspaces read are the ones `getTaskspacesInProject` returns —
 * that project's, plus any belonging to no project — so the tags come from the taskspaces
 * that project's board lists, and no others. Across the workspace it is every taskspace
 * there is, which is the same set `kozane taskspace list` prints.
 */
export async function loadTagIndex({
  db,
  projectId,
  includeFiles,
  root = getWorkspaceRoot(),
  limits,
  cache,
}: LoadTagIndex): Promise<TagIndex> {
  // No root, nowhere to keep it. That is the same condition the file walk below stops at,
  // and reading it off one value is what keeps the cache and the walk talking about one
  // workspace.
  const store = cache && root ? openTagCache({ root, dbUrl: cache.dbUrl }) : null;
  const scope = scopeKey(projectId);

  const stored = store?.cards(scope);
  const cards = stored ?? (await getCardTagHits({ db, projectId }));
  // A card set that had to be queried is a card set the stored file does not hold.
  let changed = !stored;
  const hits = [...cards.hits];
  const { cardProjects } = cards;
  const taskspaces: Record<string, TagIndexTaskspace> = {};
  const truncated: TagIndexTruncation[] = [];

  // No workspace root means no directory to resolve a taskspace against. The cards are still
  // a complete answer about cards, so the index is served rather than refused.
  if (!includeFiles || !root) {
    store?.save({ scope, cards, changed });
    return { hits, cardProjects, taskspaces, truncated };
  }

  const rows = projectId
    ? await getTaskspacesInProject({ db, projectId })
    : await getAllTaskspaces({ db });

  const scanned: { baseDir: string; changed: boolean }[] = [];
  // One budget for the whole loop, on top of each taskspace's own. The walk below is
  // synchronous — `listTaskspaceDirectory` and `readTaskspaceFile` are `readdirSync` and
  // `readFileSync` — so while it runs this process serves nothing else, not even the board's
  // poll. A per-taskspace ceiling bounds what any one of them costs and says nothing about
  // what a workspace of a dozen costs; this is that second bound. See
  // `TAG_SCAN_WORKSPACE_BYTES_MAX`.
  const pool = createScanPool(limits);
  for (const taskspace of rows) {
    if (!taskspace.path) continue;
    const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
    // Before the scan, so the files this taskspace parsed last time are already in hand when
    // the walk asks about them. The walk still happens and still checks every signature —
    // this only decides whether an unchanged file is re-read or merely re-stat'ed.
    store?.seedFiles(baseDir);
    const scan = scanTaskspaceTags(baseDir, taskspace.id, limits, pool);
    scanned.push({ baseDir, changed: scan.changed });
    changed ||= scan.changed;
    // Recorded whenever the taskspace was looked at, not only when it yielded a hit: a
    // truncation names a taskspace too, and the page has to be able to name it back.
    taskspaces[taskspace.id] = { name: taskspace.name, projectId: taskspace.projectId };
    hits.push(...scan.hits);
    if (scan.truncated.length > 0)
      truncated.push({ taskspaceId: taskspace.id, reasons: scan.truncated });
  }

  store?.save({
    scope,
    cards,
    scanned,
    changed,
    // Only a gather across the whole workspace read every taskspace there is, so only it can
    // tell a stored directory that is gone from one that simply belongs to another project.
    ...(projectId ? {} : { live: new Set(scanned.map(({ baseDir }) => baseDir)) }),
  });
  return { hits, cardProjects, taskspaces, truncated };
}
