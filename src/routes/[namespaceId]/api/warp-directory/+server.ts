import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getNamespace } from "$db/api/namespace";
import { loadWarpDirectory } from "$lib/server/warp-directory";

/**
 * Fetch other namespaces' warps when the palette opens. Avoid rereading their cards on every
 * snapshot poll.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  const namespace = await getNamespace({ db: locals.db, namespaceId: params.namespaceId });
  if (!namespace) throw error(404, "Namespace not found");

  return json(await loadWarpDirectory({ db: locals.db, namespaceId: params.namespaceId }));
};
