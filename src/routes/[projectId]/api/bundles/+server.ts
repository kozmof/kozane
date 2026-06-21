import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addBundle } from "../../../../db/api/bundle";
import { isUniqueConstraintError } from "../../../../db/api/utils";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { NAME_MAX } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);

  try {
    const id = await addBundle({ db, projectId, name });
    return json({ id });
  } catch (e) {
    if (isUniqueConstraintError(e)) throw error(400, `A bundle named "${name}" already exists`);
    throw e;
  }
};
