import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { setLayer } from "../../../../../services/cards.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await setLayer(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
