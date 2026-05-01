import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getProject } from "../../db/api/project";
import { getAllBundles } from "../../db/api/bundle";
import { getAllScopes } from "../../db/api/scope";
import { cardTable, scopeRelTable, tieTable } from "../../db/schema";
import { inArray, or } from "drizzle-orm";

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

  const cards = bundleIds.length
    ? await db.select().from(cardTable).where(inArray(cardTable.bundleId, bundleIds))
    : [];

  const cardIds = cards.map((c) => c.id);

  const [ties, scopeRels] = await Promise.all([
    cardIds.length
      ? db.select().from(tieTable).where(or(inArray(tieTable.fromCardId, cardIds), inArray(tieTable.toCardId, cardIds)))
      : Promise.resolve([]),
    cardIds.length
      ? db.select().from(scopeRelTable).where(inArray(scopeRelTable.cardId, cardIds))
      : Promise.resolve([]),
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
