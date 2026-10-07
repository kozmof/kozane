import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScope } from "$db/api/scope";
import { isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../lib/request.js";

// Scopes span namespaces, so the URL's namespace does not own the new row. An unused scope
// appears on every board until a membership, taskspace, or frame places it.
export const POST: RequestHandler = async ({ locals, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);

  try {
    const id = await addScope({ db, name });
    return json({ id });
  } catch (e) {
    if (isUniqueConstraintError(e)) throw error(400, `A scope named "${name}" already exists`);
    throw e;
  }
};
