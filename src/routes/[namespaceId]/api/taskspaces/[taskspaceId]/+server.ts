import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { renameTaskspace, removeTaskspace } from "$lib/server/taskspace-service/mutate";
import { readJsonObject } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await renameTaskspace(locals, params, await readJsonObject(request))),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) =>
  json(await removeTaskspace(locals, params)),
);
