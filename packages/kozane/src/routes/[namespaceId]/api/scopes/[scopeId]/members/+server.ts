import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "../../../../../../services/scopes.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await service.addMembers(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      params.scopeId,
      await readJsonObject(request),
    ),
  ),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await service.removeMembers(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      params.scopeId,
      await readJsonObject(request),
    ),
  ),
);
