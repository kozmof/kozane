import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addLayer } from "../../../../db/api/layer";
import { isForeignKeyError, isUniqueConstraintError } from "../../../../db/api/utils";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { NAME_MAX } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);

  try {
    const { id, position } = await addLayer({ db, projectId, name });
    return json({ id, name, position, isDefault: false });
  } catch (e) {
    if (isForeignKeyError(e)) throw error(404, "Project not found");
    if (isUniqueConstraintError(e)) throw error(400, `A layer named "${name}" already exists`);
    throw e;
  }
};
