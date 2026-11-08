import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "../../../../../services/inventories.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { apiHandler } from "$lib/server/http/api-handler.js";
import { readJsonObject } from "$lib/server/http/request.js";
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await service.update(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      params.inventoryId,
      await readJsonObject(request),
    ),
  ),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) =>
  json(
    await service.remove(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      params.inventoryId,
    ),
  ),
);
