import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteScopeFromProject } from "../../../../../db/api/scope";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;

  const ok = await deleteScopeFromProject({ db, projectId, scopeId });
  if (!ok) throw error(404, "Scope not found in project");
  return json({ ok: true });
};
