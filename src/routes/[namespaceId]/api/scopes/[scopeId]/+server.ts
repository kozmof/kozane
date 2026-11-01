import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteScopeFromNamespace, getScope, updateScopeName } from "$db/api/scope";
import { isUniqueConstraintError } from "$db/api/utils";
import { readJsonObject, requireBoundedName } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";

/** Rename a scope. Scopes span namespaces, so the new name shows on every board. */
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);

  if (!(await getScope({ db, scopeId: params.scopeId }))) throw error(404, "Scope not found");
  try {
    await updateScopeName({ db, scopeId: params.scopeId, name });
  } catch (e) {
    if (isUniqueConstraintError(e)) throw error(400, `A scope named "${name}" already exists`);
    throw e;
  }
  return json({ id: params.scopeId, name });
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, scopeId } = params;

  const ok = await deleteScopeFromNamespace({ db, namespaceId, scopeId });
  if (!ok) throw error(404, "Scope not found in namespace");
  return json({ ok: true });
});
