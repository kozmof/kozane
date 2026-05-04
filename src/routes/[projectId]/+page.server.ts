import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getProject } from "../../db/api/project";
import { getAllBundles } from "../../db/api/bundle";
import { getAllScopes } from "../../db/api/scope";
import { getCardsByBundles } from "../../db/api/card";
import { getGlueRelsByCards } from "../../db/api/glue";
import { getScopeRelsByCards } from "../../db/api/scope-rel";
import { cardsWithGlueIds } from "./lib/project-page";

export const load: PageServerLoad = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId } = params;

  const project = await getProject({ db, projectId });
  if (!project) throw error(404, "Project not found");

  const [bundles, scopes] = await Promise.all([
    getAllBundles({ db, projectId }),
    // The sidebar is a global scope picker. Scope membership is project-specific,
    // but scope definitions themselves are shared across projects.
    getAllScopes({ db }),
  ]);

  const bundleIds = bundles.map((b) => b.id);
  const cards = await getCardsByBundles({ db, bundleIds });
  const cardIds = cards.map((c) => c.id);

  const [glueRels, scopeRels] = await Promise.all([
    getGlueRelsByCards({ db, cardIds }),
    getScopeRelsByCards({ db, cardIds }),
  ]);

  return {
    project,
    bundles,
    cards: cardsWithGlueIds(cards, glueRels),
    glueRels,
    scopes,
    scopeRels,
  };
};
