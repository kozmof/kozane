import type { AnyDB } from "$db/client";
import type { Project } from "$db/api/types";
import type { ProjectDataSnapshot, TaskspaceFileTree, TaskspaceSummary } from "$lib/types";
import { getProject } from "$db/api/project";
import { getAllBundles } from "$db/api/bundle";
import { getAllLayers } from "$db/api/layer";
import { getAllWarps } from "$db/api/warp";
import { getScopesInProject } from "$db/api/scope";
import { getCardDataByBundles } from "$db/api/card";
import { getGlueRelsByProject } from "$db/api/glue";
import { getScopeRelsByProject } from "$db/api/scope-rel";
import { getTaskspacesInProject } from "$db/api/taskspace";
import { getWorkspaceRoot } from "$db/internal/config";
import { resolveTaskspacePath } from "$lib/server/taskspace-path";
import { buildTaskspaceFileTreeOnce } from "$lib/server/taskspace-snapshot";
import { cardsWithGlueIds } from "./project-page.js";

type LoadProjectSnapshot = {
  db: AnyDB;
  projectId: string;
  /**
   * Whether a taskspace's `path` — a directory on the machine the workspace lives on —
   * goes out with the rest of it.
   *
   * The live server sends it: the endpoint is behind the workspace API key, and the
   * taskspace panel exists to show the user their own directories. A static export nulls
   * it, because page data is baked into output built to be published, and the board's
   * content is the point of an export while the local paths behind it are not.
   */
  includeTaskspacePaths: boolean;
  /**
   * Whether scopes, scope relations, and taskspace summaries are fetched at all. The live
   * board always passes `true` — it has always shown scopes, independent of any export
   * flag. A static export passes `false` unless built with `--include-scoped-files`: scope
   * and taskspace organization is local-workspace detail the same as a taskspace's `path`,
   * and page data baked into a publishable export is readable via view-source regardless of
   * what the UI renders, so leaving it out has to happen here rather than only client-side.
   */
  includeScopes: boolean;
  /**
   * Whether each taskspace's file tree is walked and embedded, content inline, via
   * {@link buildTaskspaceFileTreeOnce}. Only ever `true` for a static export built with
   * `--include-scoped-files` — the live board reads files on demand through the real
   * `/taskspaces/:id/file(s)` endpoints and must not pay for a full recursive disk walk on
   * every page load or once-a-second snapshot poll. Implies `includeScopes`: a file tree
   * keyed by taskspace id is meaningless without the taskspaces themselves.
   */
  includeScopedFiles: boolean;
};

/**
 * Everything a board is drawn from, for the two callers that draw one: the page load and
 * the snapshot poll it is kept in step by.
 *
 * They were the same seven queries written out twice, in the same order, differing only in
 * what each wrapped around the result. `satisfies ProjectDataSnapshot` on both kept the
 * *shape* from drifting, but nothing kept the queries from it — a table added to the board
 * was two edits, and a board that loaded with data the poll then took away again is the
 * failure that would follow from making only one of them.
 *
 * Returns null when there is no such project, leaving each caller to say so in its own
 * terms: a 404 page from one, a 404 response from the other.
 */
export async function loadProjectSnapshot({
  db,
  projectId,
  includeTaskspacePaths,
  includeScopes,
  includeScopedFiles,
}: LoadProjectSnapshot): Promise<{ project: Project; snapshot: ProjectDataSnapshot } | null> {
  const project = await getProject({ db, projectId });
  if (!project) return null;

  const [bundles, layers, warps, scopes, taskspaces] = await Promise.all([
    getAllBundles({ db, projectId }),
    getAllLayers({ db, projectId }),
    getAllWarps({ db, projectId }),
    includeScopes ? getScopesInProject({ db, projectId }) : Promise.resolve([]),
    includeScopes ? getTaskspacesInProject({ db, projectId }) : Promise.resolve([]),
  ]);

  // Still sequential, though the data dependency that made it so is gone: the two reads
  // below select by project now rather than by the card ids this line produces, for the
  // reason `getGlueRelsByProject` gives. What is left is an ordering preference. None of
  // this is one consistent read of the database — a CLI write can land between any two of
  // these queries — so the order only decides which way that skews, and a relation row for
  // a card the board has not got is worse for the client than a card whose relation row is
  // a tick behind: the second draws as unglued until the next poll, the first refers to
  // nothing.
  const cards = await getCardDataByBundles({ db, bundleIds: bundles.map(({ id }) => id) });
  const [glueRels, scopeRels] = await Promise.all([
    getGlueRelsByProject({ db, projectId }),
    includeScopes ? getScopeRelsByProject({ db, projectId }) : Promise.resolve([]),
  ]);

  // Which taskspaces this snapshot may name at all. The panel lists a taskspace under its
  // scope and nowhere else, so one with no `scopeId` — the default for `kozane taskspace
  // create`, and for every row made without one — is unreachable in the UI, as is one whose
  // scope this project does not carry; `getTaskspacesInProject` returns both, along with
  // rows assigned to no project at all.
  //
  // On the live board that is a row nothing draws, and it keeps being sent: the board is
  // behind the workspace API key showing the user their own workspace, the same reason it
  // is sent real paths. In an export it is the name of a directory — and, below, that
  // directory's contents — published for a taskspace the site itself never mentions, which
  // is the hazard the note on `includeScopes` gives for filtering here rather than in the
  // panel. An export therefore carries the taskspaces it draws and no others.
  const drawnScopes = new Set(scopes.map(({ id }) => id));
  const namedTaskspaces = includeScopedFiles
    ? taskspaces.filter(({ scopeId }) => scopeId !== null && drawnScopes.has(scopeId))
    : taskspaces;

  // Built from the taskspace rows before their `path` is nulled below — a static export's
  // own file walk needs the real directory the same way the live `/file` endpoint does, and
  // this is the one place both a database row and the workspace root it resolves against
  // are already in hand.
  //
  // `buildTaskspaceFileTreeOnce`, not `buildTaskspaceFileTree`: a prerender calls this once
  // per project, and an unplaced taskspace is drawn by every project's board, so the same
  // directory is asked about once per project page. Its files still go into each of those
  // pages — that is what makes them browsable there — but the disk is walked for the first
  // one only. See the note on that function.
  let taskspaceFiles: Record<string, TaskspaceFileTree> | undefined;
  // `includeScopes` too, not just relying on `taskspaces` already being `[]` when it is
  // false: a file tree keyed by taskspace id is meaningless without the taskspaces
  // themselves, and this keeps that true of the code rather than of an incidental empty
  // loop — an export must never carry file contents its caller did not also ask to name.
  if (includeScopedFiles && includeScopes) {
    const root = getWorkspaceRoot();
    if (root) {
      taskspaceFiles = {};
      for (const taskspace of namedTaskspaces) {
        if (!taskspace.path) continue;
        const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
        taskspaceFiles[taskspace.id] = buildTaskspaceFileTreeOnce(baseDir);
      }
    }
  }

  const snapshot = {
    project: { id: project.id },
    cards: cardsWithGlueIds(cards, glueRels),
    bundles,
    layers,
    warps,
    scopes,
    scopeRels,
    glueRels,
    taskspaces: namedTaskspaces.map(
      ({ id, name, scopeId, path, pathKind }) =>
        ({
          id,
          name,
          scopeId,
          path: includeTaskspacePaths ? path : null,
          pathKind,
        }) satisfies TaskspaceSummary,
    ),
    ...(taskspaceFiles ? { taskspaceFiles } : {}),
  } satisfies ProjectDataSnapshot;

  // The whole project row alongside the snapshot: the page draws its name, while the
  // snapshot carries only the id the client checks it against.
  return { project, snapshot };
}
