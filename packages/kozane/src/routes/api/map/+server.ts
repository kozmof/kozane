import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { loadTreemapSnapshot } from "$lib/server/treemap-snapshot";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const GET: RequestHandler = apiHandler(async ({ locals }) =>
  json(await loadTreemapSnapshot({ db: locals.db, includeScopes: true })),
);
