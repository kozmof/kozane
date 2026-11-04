import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as service from "$lib/server/taskspace-service/files";
import { readJsonObject } from "../../../../lib/request.js";
import { apiHandler } from "../../../../lib/api-handler.js";
export const GET: RequestHandler = apiHandler(async ({ locals, params, url }) =>
  json(await service.listDirectory(locals, params, url.searchParams.get("path"))),
);
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await service.createDirectory(locals, params, await readJsonObject(request)), {
    status: 201,
  }),
);
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(await service.renameEntry(locals, params, await readJsonObject(request))),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params, url }) =>
  json(await service.removeEntry(locals, params, url.searchParams.get("path"))),
);
