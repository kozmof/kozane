import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getProject } from "../../../../db/api/project";
import { loadWarpDirectory } from "$lib/server/warp-directory";

/**
 * The other projects' warps, as the palette lists them. Fetched when the palette opens
 * rather than on the page's snapshot poll: a warp set in another project is rare enough
 * that re-reading every project's cards once a second would be waste.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const project = await getProject({ db: locals.db, projectId: params.projectId });
  if (!project) throw error(404, "Project not found");

  return json(await loadWarpDirectory({ db: locals.db, projectId: params.projectId }));
};
