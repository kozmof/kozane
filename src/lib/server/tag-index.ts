import type { AnyDB } from "../../db/client.js";
import { getCardTagHits } from "../../db/api/tag.js";
import { getAllTaskspaces, getTaskspacesInProject } from "../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../db/internal/config.js";
import type { TagHit, TagScanTruncation } from "../types.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import { createScanPool, scanTaskspaceTags, type ScanLimits } from "./taskspace-tags.js";
import { openTagCache } from "./tag-cache.js";

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
  /** A few of the paths the reasons are about, relative to the taskspace, or empty where
   *  none of them names a file. See `TaskspaceTagScan.paths`. */
  paths: string[];
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

/**
 * Those, by taskspace id — named once here rather than written out at each reader, so the
 * optional value below is a property of the record instead of a convention three signatures
 * have to keep. See {@link TagIndex.taskspaces}.
 */
export type TagIndexTaskspaces = Record<string, TagIndexTaskspace | undefined>;

export type TagIndex = {
  /** Card hits and file hits in one list, which is the point: a tag is a tag whichever it
   *  was written in, and `hit.source.kind` is the only thing that separates them. */
  hits: TagHit[];
  /** Which project each card carrying a hit belongs to. See `CardTagHits`. */
  cardProjects: Record<string, string | undefined>;
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
   *
   * The value is optional for the reason `CardTagHits.cardProjects` is: every taskspace this
   * gather walked has an entry, and a lookup can still miss — the page narrows this record to
   * the taskspaces its rows name, and the live page and a static export reach it through
   * different builds. Both readers already answer for a miss (`nameOf` here,
   * `taskspaceName` on the page); a record of non-optional values was promising them
   * something neither relied on.
   */
  taskspaces: TagIndexTaskspaces;
  truncated: TagIndexTruncation[];
  /**
   * The taskspaces this gather could not open at all, by id — a record whose directory has
   * been deleted, moved, or made unreadable since it was written.
   *
   * Apart from {@link TagIndex.truncated} rather than one of its reasons, which is where this
   * was. The two are different things to have to tell someone: a truncation says a taskspace
   * was read and not to the end, and a reader acts on it by looking at the file it names;
   * this says a record points at nothing, and the way to act on it is to drop the record —
   * `kozane taskspace scan --apply --cleanup`, which both readers print. Folded in as a
   * reason it read as the first, and told the user that "some files could not be read" in a
   * taskspace that no longer exists.
   *
   * Ids only, for the reason {@link TagIndexTruncation} carries only an id:
   * {@link TagIndex.taskspaces} names every taskspace this gather walked, and one it could
   * not read is still one it walked.
   */
  missing: string[];
  /**
   * Whether the card side stopped at {@link TAG_CARD_HITS_MAX}, so the hits above hold a
   * prefix of the workspace's card tags rather than all of them.
   *
   * Apart from {@link TagIndex.truncated}, which is per taskspace and carries the walk's own
   * vocabulary of reasons. There is one card query per gather and one ceiling for it to
   * reach, so this is the whole of what there is to say about it. Both are printed together
   * by every reader, because to someone looking at a tag that is missing they are the same
   * fact: part of the workspace was not read.
   */
  cardsTruncated: boolean;
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
  const store =
    cache && root
      ? openTagCache({ root, dbUrl: cache.dbUrl, ...(projectId && { projectId }) })
      : null;

  const stored = store?.cards();
  const cards = stored ?? (await getCardTagHits({ db, projectId }));
  // A card set that had to be queried is a card set the stored file does not hold.
  let changed = !stored;
  const hits = [...cards.hits];
  const { cardProjects } = cards;
  const taskspaces: Record<string, TagIndexTaskspace> = {};
  const truncated: TagIndexTruncation[] = [];
  const missing: string[] = [];

  // No workspace root means no directory to resolve a taskspace against. The cards are still
  // a complete answer about cards, so the index is served rather than refused.
  if (!includeFiles || !root) {
    store?.save({ cards, changed });
    return { hits, cardProjects, taskspaces, truncated, missing, cardsTruncated: cards.truncated };
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
  const pool = createScanPool(limits?.gather);
  for (const taskspace of rows) {
    if (!taskspace.path) continue;
    const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
    // Before the scan, so the files this taskspace parsed last time are already in hand when
    // the walk asks about them. The walk still happens and still checks every signature —
    // this only decides whether an unchanged file is re-read or merely re-stat'ed.
    store?.seedFiles(baseDir);
    const scan = scanTaskspaceTags(baseDir, taskspace.id, limits?.taskspace, pool);
    scanned.push({ baseDir, changed: scan.changed });
    changed ||= scan.changed;
    // Recorded whenever the taskspace was looked at, not only when it yielded a hit: a
    // truncation names a taskspace too, and the page has to be able to name it back.
    taskspaces[taskspace.id] = { name: taskspace.name, projectId: taskspace.projectId };
    // Appended rather than spread as arguments. `push(...scan.hits)` passes one argument per
    // hit, and an engine's argument limit is reached somewhere past a hundred thousand of
    // them — so a taskspace holding enough tags took the page down with
    // `RangeError: Maximum call stack size exceeded` rather than answering. `TAG_SCAN_HITS_MAX`
    // now bounds a scan well below that, and this does not depend on it staying there.
    for (const hit of scan.hits) hits.push(hit);
    if (scan.truncated.length > 0)
      truncated.push({
        taskspaceId: taskspace.id,
        reasons: scan.truncated,
        paths: scan.paths,
      });
    // Beside the truncations and not among them: a taskspace that could not be opened has no
    // reason to give and nothing for one to be about. See `TagIndex.missing`.
    if (scan.missing) missing.push(taskspace.id);
  }

  store?.save({ cards, scanned, changed });
  return { hits, cardProjects, taskspaces, truncated, missing, cardsTruncated: cards.truncated };
}
