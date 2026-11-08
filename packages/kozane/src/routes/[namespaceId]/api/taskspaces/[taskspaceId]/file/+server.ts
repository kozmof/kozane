import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "$lib/server/taskspace-service/file";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const GET: RequestHandler = apiHandler(async ({ locals, params, url }) =>
  json(await service.readFile(locals, params, url.searchParams.get("path"))),
);
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await service.createFile(locals, params, await readJsonObject(request)), { status: 201 }),
);
export const PUT: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await service.saveFile(locals, params, await readJsonObject(request))),
);
