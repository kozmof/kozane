import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { moveCardsToProject } from "../../../../../db/api/composite";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const targetProjectId = requireString(body, "targetProjectId");
  const cardIds = requireStringArray(body, "cardIds");
  if (targetProjectId === projectId) throw error(400, "Target project must differ from source");
  const ok = await moveCardsToProject({ db, sourceProjectId: projectId, targetProjectId, cardIds });
  if (!ok) throw error(400, "Some cards do not belong to this project");
  return json({ ok: true });
};
