import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { moveCardsToProject } from "$db/api/composite";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const targetProjectId = requireString(body, "targetProjectId");
  const cardIds = requireStringArray(body, "cardIds");
  if (targetProjectId === projectId) throw error(400, "Target project must differ from source");
  const result = await moveCardsToProject({
    db,
    sourceProjectId: projectId,
    targetProjectId,
    cardIds,
  });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
};
