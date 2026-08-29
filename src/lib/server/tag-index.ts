import type { AnyDB } from "../../db/client.js";
import { getCardTagHits } from "../../db/api/tag.js";
import { getAllTaskspaces, getTaskspacesInProject } from "../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../db/internal/config.js";
import type { TagHit, TagScanTruncation } from "../types.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import {
  exportTaskspaceTagCache,
  importTaskspaceTagCache,
  scanTaskspaceTags,
  type ScanLimits,
} from "./taskspace-tags.js";
import {
  databaseSignature,
  readTagCache,
  writeTagCache,
  TAG_CACHE_VERSION,
  type CachedCardHits,
  type TagCache,
} from "./tag-cache.js";

/**
 * What one taskspace could not tell us, and which one it was. Empty for a taskspace read
 * whole, and absent from the list entirely rather than present with nothing to say.
 *
 * The name is carried rather than left to be looked up. Both callers have to name the
 * taskspace back to the reader — a warning naming an id says nothing — and each was fetching
 * the taskspace rows a second time to do it, from the very read this walked. The static
 * export has a further reason: it publishes no taskspace list at all, so a page that could
 * only join a name from one would have had nothing to say.
 */
export type TagIndexTruncation = {
  taskspaceId: string;
  taskspaceName: string;
  reasons: TagScanTruncation[];
};

export type TagIndex = {
  /** Card hits and file hits in one list, which is the point: a tag is a tag whichever it
   *  was written in, and `hit.source.kind` is the only thing that separates them. */
  hits: TagHit[];
  /** Which project each card carrying a hit belongs to. See `CardTagHits`. */
  cardProjects: Record<string, string>;
  /**
   * Which project each taskspace carrying a hit belongs to, or null for one belonging to
   * none. Null is not missing data: an unplaced taskspace is drawn on every board (see
   * `getTaskspacesInProject`), so a hit in one has no single board to be sent back to.
   */
  taskspaceProjects: Record<string, string | null>;
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

/** How a scope is named in the cache file. `*` is the gather across the whole workspace,
 *  which is a different set from any one project's and so a different entry. */
const scopeKey = (projectId?: string) => projectId ?? "*";

/**
 * How many scopes the cache file keeps. A workspace has few projects and the index is looked
 * at one scope at a time, so this is a backstop against a file that grows forever rather than
 * a limit anyone reaches: at a realistic size one scope is around a megabyte.
 */
const SCOPES_MAX = 16;

/**
 * How many taskspace directories the cache file keeps entries for. The same backstop
 * {@link SCOPES_MAX} is, for the other half of the file, and it was missing: `files` only
 * ever gained keys, so a taskspace deleted, renamed, or re-pathed left its every parsed file
 * in `tag-index.json` for good.
 *
 * The precise cleanup is the one below — a gather across the whole workspace knows every
 * taskspace there is and drops what is not among them. This bounds the case that cannot do
 * that, a workspace only ever looked at one project at a time, and is set well above the
 * number of taskspaces anyone has so that eviction is the exception rather than the rhythm.
 */
const FILE_DIRS_MAX = 64;

/**
 * The persisted gather, opened once per `loadTagIndex` call.
 *
 * Reading the file is the only I/O this does up front. What it hands back is checked before
 * use — card hits against the database's signature, file entries against each file's own —
 * so a cache that has fallen behind costs a re-gather and never a wrong answer.
 */
function openTagCache({ root, dbUrl }: { root: string; dbUrl: string }) {
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
    cards: (scope: string): CachedCardHits | null =>
      fresh ? (existing?.scopes[scope] ?? null) : null,

    seedFiles: (baseDir: string) => {
      const entries = files[baseDir];
      if (entries) importTaskspaceTagCache(baseDir, entries);
    },

    save: ({ scope, cards, scanned = [], live, changed }: SaveCache) => {
      const scopes = fresh ? { ...existing?.scopes } : {};
      // Deleted before it is set, so a scope looked at again moves to the end rather than
      // keeping the position it first took. That is what makes insertion order visit order.
      delete scopes[scope];
      scopes[scope] = cards;
      // Oldest out: what goes is the scope nobody has looked at for longest.
      for (const stale of Object.keys(scopes).slice(0, -SCOPES_MAX)) delete scopes[stale];

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
        // Re-set even when it was already there, so a directory looked at again moves to the
        // end of the insertion order the eviction below reads as least-recently-used.
        const kept = nextFiles[baseDir];
        delete nextFiles[baseDir];
        // The entries this process holds, but only where they can differ from what is
        // already stored. Exporting rebuilds the record, and a fresh object of identical
        // contents is what would make the no-op check below fail and write anyway.
        const entries = moved || !kept ? exportTaskspaceTagCache(baseDir) : kept;
        if (entries) nextFiles[baseDir] = entries;
      }
      for (const stale of Object.keys(nextFiles).slice(0, -FILE_DIRS_MAX)) delete nextFiles[stale];

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

type SaveCache = {
  scope: string;
  cards: CachedCardHits;
  /** The taskspace directories this gather walked, each with whether its scan learned
   *  anything — which decides between re-exporting its entries and keeping the stored ones. */
  scanned?: { baseDir: string; changed: boolean }[];
  /** Every taskspace directory in the workspace, when this gather saw them all — which is
   *  only a gather that named no project. Absent, no directory is presumed gone. */
  live?: Set<string>;
  /** Whether any scan read or dropped something. See `TaskspaceTagScan.changed`. */
  changed: boolean;
};

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
  const taskspaceProjects: Record<string, string | null> = {};
  const truncated: TagIndexTruncation[] = [];

  // No workspace root means no directory to resolve a taskspace against. The cards are still
  // a complete answer about cards, so the index is served rather than refused.
  if (!includeFiles || !root) {
    store?.save({ scope, cards, changed });
    return { hits, cardProjects, taskspaceProjects, truncated };
  }

  const taskspaces = projectId
    ? await getTaskspacesInProject({ db, projectId })
    : await getAllTaskspaces({ db });

  const scanned: { baseDir: string; changed: boolean }[] = [];
  for (const taskspace of taskspaces) {
    if (!taskspace.path) continue;
    const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
    // Before the scan, so the files this taskspace parsed last time are already in hand when
    // the walk asks about them. The walk still happens and still checks every signature —
    // this only decides whether an unchanged file is re-read or merely re-stat'ed.
    store?.seedFiles(baseDir);
    const scan = scanTaskspaceTags(baseDir, taskspace.id, limits);
    scanned.push({ baseDir, changed: scan.changed });
    changed ||= scan.changed;
    // Recorded whenever the taskspace was looked at, not only when it yielded a hit: a
    // truncation names a taskspace too, and the page has to be able to name it back.
    taskspaceProjects[taskspace.id] = taskspace.projectId;
    hits.push(...scan.hits);
    if (scan.truncated.length > 0)
      truncated.push({
        taskspaceId: taskspace.id,
        taskspaceName: taskspace.name,
        reasons: scan.truncated,
      });
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
  return { hits, cardProjects, taskspaceProjects, truncated };
}
