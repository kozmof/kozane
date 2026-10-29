import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { updateLayerName } from "$db/api/layer";
import { deleteLayerWithReassign } from "$db/api/composite";
import { isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";

export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, layerId } = params;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);

  try {
    await updateLayerName({ db, namespaceId, layerId, name });
  } catch (e) {
    if (isUniqueConstraintError(e)) throw error(400, `A layer named "${name}" already exists`);
    throw e;
  }
  return json({ ok: true });
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, layerId } = params;

  const { defaultLayerId, stacking } = await deleteLayerWithReassign({
    db,
    namespaceId,
    layerId,
  });
  return json({ ok: true, defaultLayerId, stacking });
});
