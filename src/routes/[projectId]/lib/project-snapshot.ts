import type { AnyDB } from "../../../db/client";
import type { Project } from "../../../db/api/types";
import type { ProjectDataSnapshot, TaskspaceSummary } from "$lib/types";
import { getProject } from "../../../db/api/project";
import { getAllBundles } from "../../../db/api/bundle";
import { getAllLayers } from "../../../db/api/layer";
import { getAllWarps } from "../../../db/api/warp";
import { getScopesInProject } from "../../../db/api/scope";
import { getCardsByBundles } from "../../../db/api/card";
import { getGlueRelsByCards } from "../../../db/api/glue";
import { getScopeRelsByCards } from "../../../db/api/scope-rel";
import { getTaskspacesInProject } from "../../../db/api/taskspace";
import { cardsWithGlueIds } from "./project-page";

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
}: LoadProjectSnapshot): Promise<{ project: Project; snapshot: ProjectDataSnapshot } | null> {
  const project = await getProject({ db, projectId });
  if (!project) return null;

  const [bundles, layers, warps, scopes, taskspaces] = await Promise.all([
    getAllBundles({ db, projectId }),
    getAllLayers({ db, projectId }),
    getAllWarps({ db, projectId }),
    getScopesInProject({ db, projectId }),
    getTaskspacesInProject({ db, projectId }),
  ]);

  // Sequential, unlike the rest: the cards are what the two relation reads below are keyed
  // by, so there is nothing to overlap them with.
  const cards = await getCardsByBundles({ db, bundleIds: bundles.map(({ id }) => id) });
  const cardIds = cards.map(({ id }) => id);
  const [glueRels, scopeRels] = await Promise.all([
    getGlueRelsByCards({ db, cardIds }),
    getScopeRelsByCards({ db, cardIds }),
  ]);

  const snapshot = {
    project: { id: project.id },
    cards: cardsWithGlueIds(cards, glueRels),
    bundles,
    layers,
    warps,
    scopes,
    scopeRels,
    glueRels,
    taskspaces: taskspaces.map(
      ({ id, name, scopeId, path, pathKind }) =>
        ({
          id,
          name,
          scopeId,
          path: includeTaskspacePaths ? path : null,
          pathKind,
        }) satisfies TaskspaceSummary,
    ),
  } satisfies ProjectDataSnapshot;

  // The whole project row alongside the snapshot: the page draws its name, while the
  // snapshot carries only the id the client checks it against.
  return { project, snapshot };
}
