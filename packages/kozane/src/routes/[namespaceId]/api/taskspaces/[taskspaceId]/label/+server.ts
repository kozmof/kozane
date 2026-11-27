import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { renameTaskspaceLabel } from "$lib/server/taskspace-service/label.js";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";

export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await renameTaskspaceLabel(locals, params, await readJsonObject(request))),
);
