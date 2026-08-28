import type { AnyDB } from "../../db/client.js";
import { getCardTagHits } from "../../db/api/tag.js";
import { getAllTaskspaces, getTaskspacesInProject } from "../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../db/internal/config.js";
import type { TagHit } from "../types.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import { scanTaskspaceTags, type ScanLimits, type TagScanTruncation } from "./taskspace-tags.js";

/** What one taskspace could not tell us, and which one it was. Empty for a taskspace read
 *  whole, and absent from the list entirely rather than present with nothing to say. */
export type TagIndexTruncation = { taskspaceId: string; reasons: TagScanTruncation[] };

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
}: LoadTagIndex): Promise<TagIndex> {
  const { hits, cardProjects } = await getCardTagHits({ db, projectId });
  const taskspaceProjects: Record<string, string | null> = {};
  const truncated: TagIndexTruncation[] = [];
  // No workspace root means no directory to resolve a taskspace against. The cards are still
  // a complete answer about cards, so the index is served rather than refused.
  if (!includeFiles || !root) return { hits, cardProjects, taskspaceProjects, truncated };

  const taskspaces = projectId
    ? await getTaskspacesInProject({ db, projectId })
    : await getAllTaskspaces({ db });

  for (const taskspace of taskspaces) {
    if (!taskspace.path) continue;
    const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
    const scan = scanTaskspaceTags(baseDir, taskspace.id, limits);
    // Recorded whenever the taskspace was looked at, not only when it yielded a hit: a
    // truncation names a taskspace too, and the page has to be able to name it back.
    taskspaceProjects[taskspace.id] = taskspace.projectId;
    hits.push(...scan.hits);
    if (scan.truncated.length > 0)
      truncated.push({ taskspaceId: taskspace.id, reasons: scan.truncated });
  }

  return { hits, cardProjects, taskspaceProjects, truncated };
}
