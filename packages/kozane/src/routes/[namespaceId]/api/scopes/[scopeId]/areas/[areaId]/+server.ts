import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "../../../../../../../services/scopes.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "../../../../../lib/request.js";
import { apiHandler } from "../../../../../lib/api-handler.js";
export const PATCH: RequestHandler = apiHandler(
  async ({ locals, params, request }) =>
    json(
      await service.updateArea(
        locals.db,
        workspaceServiceContext(),
        params.namespaceId,
        params.scopeId,
        params.areaId,
        await readJsonObject(request),
      ),
    ),
  { notFound: "Scope area not found" },
);
export const DELETE: RequestHandler = apiHandler(
  async ({ locals, params }) =>
    json(
      await service.removeArea(
        locals.db,
        workspaceServiceContext(),
        params.namespaceId,
        params.scopeId,
        params.areaId,
      ),
    ),
  { notFound: "Scope area not found" },
);
