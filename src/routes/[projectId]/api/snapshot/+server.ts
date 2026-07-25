import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getProject } from "../../../../db/api/project";
import { getAllBundles } from "../../../../db/api/bundle";
import { getAllScopes } from "../../../../db/api/scope";
import { getCardsByBundles } from "../../../../db/api/card";
import { getGlueRelsByCards } from "../../../../db/api/glue";
import { getScopeRelsByCards } from "../../../../db/api/scope-rel";
import { getAllWorkingCopies } from "../../../../db/api/working-copy";
import { cardsWithGlueIds } from "../../lib/project-page";

export const GET: RequestHandler = async ({ locals, params }) => {
  const project = await getProject({ db: locals.db, projectId: params.projectId });
  if (!project) throw error(404, "Project not found");

  const [bundles, scopes, workingCopies] = await Promise.all([
    getAllBundles({ db: locals.db, projectId: params.projectId }),
    getAllScopes({ db: locals.db }),
    getAllWorkingCopies({ db: locals.db }),
  ]);
  const cards = await getCardsByBundles({
    db: locals.db,
    bundleIds: bundles.map(({ id }) => id),
  });
  const cardIds = cards.map(({ id }) => id);
  const [glueRels, scopeRels] = await Promise.all([
    getGlueRelsByCards({ db: locals.db, cardIds }),
    getScopeRelsByCards({ db: locals.db, cardIds }),
  ]);

  return json({
    project: { id: project.id },
    cards: cardsWithGlueIds(cards, glueRels),
    bundles,
    scopes,
    scopeRels,
    glueRels,
    workingCopies,
  });
};
