import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { create, updatePositions, remove } from "../../../../services/cards.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "../../lib/request.js";
import { apiHandler } from "../../lib/api-handler.js";
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await create(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await updatePositions(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await remove(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
