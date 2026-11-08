import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { setPartition } from "../../../../../services/cards.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await setPartition(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      await readJsonObject(request),
    ),
  ),
);
