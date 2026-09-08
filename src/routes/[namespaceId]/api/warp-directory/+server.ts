import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getNamespace } from "$db/api/namespace";
import { loadWarpDirectory } from "$lib/server/warp-directory";

/**
 * The other namespaces' warps, as the palette lists them. Fetched when the palette opens
 * rather than on the page's snapshot poll: a warp set in another namespace is rare enough
 * that re-reading every namespace's cards once a second would be waste.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const namespace = await getNamespace({ db: locals.db, namespaceId: params.namespaceId });
  if (!namespace) throw error(404, "Namespace not found");

  return json(await loadWarpDirectory({ db: locals.db, namespaceId: params.namespaceId }));
};
