import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getScope, deleteScope } from "../../../../../db/api/scope";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { scopeId } = params;

  const scope = await getScope({ db, scopeId });
  if (!scope) throw error(404, "Scope not found");

  await deleteScope({ db, scopeId });
  return json({ ok: true });
};
