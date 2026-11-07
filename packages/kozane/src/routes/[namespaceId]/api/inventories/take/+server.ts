import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "../../../../../services/inventories.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { apiHandler } from "../../../lib/api-handler.js";
import { readJsonObject } from "../../../lib/request.js";
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await service.take(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
