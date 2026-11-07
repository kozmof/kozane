import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as namespaces from "../../../services/namespaces.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { apiHandler } from "../../[namespaceId]/lib/api-handler.js";
import { readJsonObject } from "../../[namespaceId]/lib/request.js";
export const GET: RequestHandler = apiHandler(async ({ locals }) =>
  json(await namespaces.list(locals.db, workspaceServiceContext())),
);
export const POST: RequestHandler = apiHandler(async ({ locals, request }) =>
  json(
    await namespaces.create(locals.db, workspaceServiceContext(), await readJsonObject(request)),
  ),
);
