import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScope } from "$db/api/scope";
import { isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../lib/request.js";

// params.projectId is intentionally unused: scopes are cross-project by design, so there
// is no per-project scope table to insert into. The projectId in the URL is present for
// API consistency, not access control.
//
// The new scope refers to nothing yet, which is exactly the state `getScopesInProject`
// shows to every board — so it appears in this project's sidebar immediately, and stops
// being visible elsewhere as soon as a card or taskspace places it.
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
