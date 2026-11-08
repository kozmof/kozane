import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { createTaskspace } from "$lib/server/taskspace-service/create";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await createTaskspace(locals.db, params.namespaceId, await readJsonObject(request))),
);
