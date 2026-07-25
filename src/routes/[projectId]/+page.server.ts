import type { EntryGenerator, PageServerLoad } from "./$types";
import type { WorkingCopySummary } from "$lib/types";
import { error } from "@sveltejs/kit";
import { getDb } from "../../db/client";
import { getProject, getAllProjects } from "../../db/api/project";
import { getAllBundles } from "../../db/api/bundle";
import { getAllScopes } from "../../db/api/scope";
import { getCardsByBundles } from "../../db/api/card";
import { getGlueRelsByCards } from "../../db/api/glue";
import { getScopeRelsByCards } from "../../db/api/scope-rel";
import { cardsWithGlueIds } from "./lib/project-page";
import { getWorkspaceUiConfig } from "../../db/internal/config";
import { getAllWorkingCopies } from "../../db/api/working-copy";

// Static export (kozane ssg): prerender one page per project. `entries` tells
// SvelteKit which [projectId] values to bake out, and `readonly` flows to the UI
// so it hides all editing affordances and the live-sync poll.
export const prerender = process.env.KOZANE_SSG === "1";
const readonly = process.env.KOZANE_READONLY === "1";

export const entries: EntryGenerator = async () => {
  // Only touch the database when actually building the static export. A normal
  // (adapter-node) build still evaluates this generator but has no workspace.
  if (!prerender) return [];
  const db = await getDb();
  const projects = await getAllProjects({ db });
  return projects.map((p) => ({ projectId: p.id }));
};

export const load: PageServerLoad = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId } = params;

  const project = await getProject({ db, projectId });
  if (!project) throw error(404, "Project not found");

  const [bundles, scopes, allProjects] = await Promise.all([
    getAllBundles({ db, projectId }),
    getAllScopes({ db }),
    getAllProjects({ db }),
  ]);

  const bundleIds = bundles.map((b) => b.id);
  const cards = await getCardsByBundles({ db, bundleIds });
  const cardIds = cards.map((c) => c.id);

  const [glueRels, scopeRels, workingCopies] = await Promise.all([
    getGlueRelsByCards({ db, cardIds }),
    getScopeRelsByCards({ db, cardIds }),
    getAllWorkingCopies({ db }), // intentionally unscoped — see working-copy.ts
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
    readonly,
  };
};
