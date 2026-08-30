import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addScopeMembers, removeScopeMembersFromProject } from "$db/api/scope-rel";
import { readJsonObject, requireStringArray } from "../../../../lib/request.js";
import { rejectBatch } from "../../../../lib/rejection.js";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const result = await addScopeMembers({ db, scopeId, projectId, cardIds });
  if (!result.ok) rejectBatch(result.reason);

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const result = await removeScopeMembersFromProject({ db, scopeId, projectId, cardIds });
  if (!result.ok) rejectBatch(result.reason);

  return json({ ok: true });
};
