import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { get as getNamespace } from "../../../../services/namespaces.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { loadWarpDirectory } from "$lib/server/warp-directory";
import { apiHandler } from "$lib/server/http/api-handler.js";

/**
 * Fetch other namespaces' warps when the palette opens. Avoid rereading their cards on every
 * snapshot poll.
 */
export const GET: RequestHandler = apiHandler(async ({ locals, params }) => {
  await getNamespace(locals.db, workspaceServiceContext(), params.namespaceId);

  return json(await loadWarpDirectory({ db: locals.db, namespaceId: params.namespaceId }));
});
