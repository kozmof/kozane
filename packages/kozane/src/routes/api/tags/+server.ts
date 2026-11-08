import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { assembleViewData } from "../../../services/tags.js";
import { get as getNamespace } from "../../../services/namespaces.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { loadTagIndex } from "$lib/server/tag-index";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const GET: RequestHandler = apiHandler(async ({ locals, url }) => {
  const context = workspaceServiceContext();
  const namespaceId = url.searchParams.get("namespaceId") ?? undefined;
  if (namespaceId !== undefined) await getNamespace(locals.db, context, namespaceId);
  const index = await loadTagIndex({ db: locals.db, namespaceId, includeFiles: true });
  return json(await assembleViewData(locals.db, context, index));
});
