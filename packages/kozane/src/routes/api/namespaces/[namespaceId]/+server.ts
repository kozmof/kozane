import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import * as namespaces from "../../../../services/namespaces.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { apiHandler } from "$lib/server/http/api-handler.js";
export const GET: RequestHandler = apiHandler(async ({ locals, params }) =>
  json(await namespaces.get(locals.db, workspaceServiceContext(), params.namespaceId)),
);
