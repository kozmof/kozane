import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addPartition } from "$db/api/partition";
import { isForeignKeyError, isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../lib/request.js";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);

  try {
    const id = await addPartition({ db, namespaceId, name });
    return json({ id });
  } catch (e) {
    if (isForeignKeyError(e)) throw error(404, "Namespace not found");
    if (isUniqueConstraintError(e)) throw error(400, `A partition named "${name}" already exists`);
    throw e;
  }
};
