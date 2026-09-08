import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteScopeFromNamespace } from "$db/api/scope";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, scopeId } = params;

  const ok = await deleteScopeFromNamespace({ db, namespaceId, scopeId });
  if (!ok) throw error(404, "Scope not found in namespace");
  return json({ ok: true });
};
