import type { PageServerLoad } from "./$types";
import type { WorkingCopySummary } from "$lib/types";
import { error } from "@sveltejs/kit";
import { getProject, getAllProjects } from "../../db/api/project";
import { getAllBundles } from "../../db/api/bundle";
import { getScopesByProject } from "../../db/api/scope";
import { getCardsByBundles } from "../../db/api/card";
import { getGlueRelsByCards } from "../../db/api/glue";
import { getScopeRelsByCards } from "../../db/api/scope-rel";
import { cardsWithGlueIds } from "./lib/project-page";
import { getWorkspaceUiConfig } from "../../db/internal/config";
import { getWorkingCopiesByProject } from "../../db/api/working-copy";

export const load: PageServerLoad = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId } = params;

  const project = await getProject({ db, projectId });
  if (!project) throw error(404, "Project not found");

  const [bundles, scopes, allProjects] = await Promise.all([
    getAllBundles({ db, projectId }),
    // Load only scopes that have working copies in this project. Scopes are global by design,
    // but for the initial load we only need the ones relevant here. New scopes created by the
    // user are optimistically appended to client state without a reload.
    getScopesByProject({ db, projectId }),
    getAllProjects({ db }),
  ]);

  const bundleIds = bundles.map((b) => b.id);
  const cards = await getCardsByBundles({ db, bundleIds });
  const cardIds = cards.map((c) => c.id);

  const [glueRels, scopeRels, workingCopies] = await Promise.all([
    getGlueRelsByCards({ db, cardIds }),
    getScopeRelsByCards({ db, cardIds }),
    getWorkingCopiesByProject({ db, projectId }),
  ]);

  return {
    project,
    bundles,
    otherProjects: allProjects.filter((p) => p.id !== projectId),
    cards: cardsWithGlueIds(cards, glueRels),
    glueRels,
    scopes,
    scopeRels,
    workingCopies: workingCopies.map(
      (wc) =>
        ({
          id: wc.id,
          name: wc.name,
          scopeId: wc.scopeId,
          path: wc.path,
          pathKind: wc.pathKind,
        }) satisfies WorkingCopySummary,
    ),
    uiConfig: getWorkspaceUiConfig(),
  };
};
