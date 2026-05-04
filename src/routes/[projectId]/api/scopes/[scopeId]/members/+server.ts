import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScopeMembers, removeScopeMembersFromProject } from "../../../../../../db/api/scope-rel";
import { readJsonObject, requireStringArray } from "../../../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const ok = await addScopeMembers({ db, scopeId, projectId, cardIds });
  if (!ok) throw error(400, "Some cards not found in project");

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const ok = await removeScopeMembersFromProject({ db, scopeId, projectId, cardIds });
  if (!ok) throw error(400, "Some cards do not belong to this project");

  return json({ ok: true });
};
