import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { openedDbUrl } from "$db/client";
import { workspaceChangeToken } from "$lib/server/workspace-change-token";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const GET: RequestHandler = apiHandler(async ({ locals }) =>
  json(
    { token: workspaceChangeToken(locals.db, openedDbUrl()) },
    { headers: { "cache-control": "no-store" } },
  ),
);
