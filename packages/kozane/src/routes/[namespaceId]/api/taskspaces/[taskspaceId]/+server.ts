import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { renameTaskspace, removeTaskspace } from "$lib/server/taskspace-service/mutate";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  // Compatibility endpoint for clients that combine label and directory changes.
  // Current clients use the separate /label endpoint.
  json(await renameTaskspace(locals, params, await readJsonObject(request))),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) =>
  json(await removeTaskspace(locals, params)),
);
