import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "../../../../services/layers.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "../../lib/request.js";
import { apiHandler } from "../../lib/api-handler.js";
export const POST: RequestHandler = apiHandler(
  async ({ locals, params, request }) =>
    json(
      await service.create(
        locals.db,
        workspaceServiceContext(),
        params.namespaceId,
        await readJsonObject(request),
      ),
    ),
  { foreignKey: "Namespace not found", conflictStatus: 400 },
);
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await service.reorder(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
