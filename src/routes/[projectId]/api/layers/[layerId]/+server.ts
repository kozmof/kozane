import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { updateLayerName } from "$db/api/layer";
import { deleteLayerWithReassign } from "$db/api/composite";
import { NotFoundError, DefaultLayerError, isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireTrimmedString } from "../../../lib/request.js";
import { NAME_MAX } from "$lib/constants";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, layerId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);

  try {
    await updateLayerName({ db, projectId, layerId, name });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    if (isUniqueConstraintError(e)) throw error(400, `A layer named "${name}" already exists`);
    throw e;
  }
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, layerId } = params;

  try {
    const { defaultLayerId } = await deleteLayerWithReassign({ db, projectId, layerId });
    return json({ ok: true, defaultLayerId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    if (e instanceof DefaultLayerError) throw error(400, e.message);
    throw e;
  }
};
