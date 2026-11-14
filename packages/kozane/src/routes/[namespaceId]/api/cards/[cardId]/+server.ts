import { withImageDeletion } from "$lib/server/image-assets.js";
import { getWorkspaceRoot } from "../../../../../db/internal/config.js";
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { workspaceServiceContext } from "$lib/server/service-context";
import { readJsonObject } from "$lib/server/http/request.js";
import { apiHandler } from "$lib/server/http/api-handler.js";
import { update, removeOne } from "../../../../../services/cards.js";
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) =>
  json(
    await update(
      locals.db,
      workspaceServiceContext(),
      params.namespaceId,
      params.cardId,
      await readJsonObject(request),
    ),
  ),
);
export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) =>
  json(
    await withImageDeletion(getWorkspaceRoot(), locals.db, () =>
      removeOne(locals.db, workspaceServiceContext(), params.namespaceId, params.cardId),
    ),
  ),
);
