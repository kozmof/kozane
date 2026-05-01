import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getProject } from "../../db/api/project";
import { getAllBundles } from "../../db/api/bundle";
import { getAllScopes } from "../../db/api/scope";
import { getCardsByBundles } from "../../db/api/card";
import { getTiesByCards } from "../../db/api/tie";
import { getScopeRelsByCards } from "../../db/api/scope-rel";

export const load: PageServerLoad = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId } = params;

  const project = await getProject({ db, projectId });
  if (!project) throw error(404, "Project not found");

  const [bundles, scopes] = await Promise.all([
    getAllBundles({ db, projectId }),
    getAllScopes({ db }),
  ]);

  const bundleIds = bundles.map((b) => b.id);
  const cards = await getCardsByBundles({ db, bundleIds });
  const cardIds = cards.map((c) => c.id);

  const [ties, scopeRels] = await Promise.all([
    getTiesByCards({ db, cardIds }),
    getScopeRelsByCards({ db, cardIds }),
  ]);

  const tieCountMap = new Map<string, number>();
  for (const tie of ties) {
    tieCountMap.set(tie.fromCardId, (tieCountMap.get(tie.fromCardId) ?? 0) + 1);
    tieCountMap.set(tie.toCardId, (tieCountMap.get(tie.toCardId) ?? 0) + 1);
  }

  const cardsWithTies = cards.map((c) => ({
    ...c,
    tieCount: tieCountMap.get(c.id) ?? 0,
  }));

  return { project, bundles, cards: cardsWithTies, scopes, scopeRels };
};
