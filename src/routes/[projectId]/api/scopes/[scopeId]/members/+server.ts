import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScopeMembers } from "../../../../../../db/api/scope-rel";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, scopeId } = params;
  const body = await request.json();
  const { cardIds } = body;

  if (!Array.isArray(cardIds) || cardIds.length === 0) throw error(400, "cardIds is required");

  const ok = await addScopeMembers({ db, scopeId, projectId, cardIds });
  if (!ok) throw error(400, "Some cards not found in project");

  return json({ ok: true });
};
