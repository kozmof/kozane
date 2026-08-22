import type { EntryGenerator, PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getDb } from "../../db/client";
import { getAllProjects } from "../../db/api/project";
import { loadProjectSnapshot } from "./lib/project-snapshot";
import { getWorkspaceUiConfig } from "../../db/internal/config";
import { loadWarpDirectory } from "$lib/server/warp-directory";

// Static export (kozane net ssg generate): prerender one page per project. `entries` tells
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

  // The same read `/api/snapshot` makes, so the board this page opens on and the board the
  // poll keeps it at are assembled by one piece of code rather than two.
  const [loaded, allProjects, warpDirectory] = await Promise.all([
    loadProjectSnapshot({ db, projectId, includeTaskspacePaths: !prerender }),
    getAllProjects({ db }),
    // The other projects' warps, for the Shift+arrow palette. Baked into a static export
    // too, which is why the palette works there without an endpoint to call. Independent
    // of the board itself, so it is read alongside rather than after it.
    loadWarpDirectory({ db, projectId }),
  ]);
  if (!loaded) throw error(404, "Project not found");

  return {
    ...loaded.snapshot,
    project: loaded.project,
    warpDirectory,
    otherProjects: allProjects.filter((p) => p.id !== projectId),
    uiConfig: getWorkspaceUiConfig(),
    readonly,
  };
};
