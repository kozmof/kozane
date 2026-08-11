import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getLayer } from "../../../../../db/api/layer";
import { reassignCardsToLayer } from "../../../../../db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const layerId = requireString(body, "layerId");
  const layer = await getLayer({ db, projectId, layerId });
  if (!layer) throw error(400, "Layer not found in project");
  const cardIds = requireStringArray(body, "cardIds");
  if (!(await reassignCardsToLayer({ db, projectId, cardIds, layerId })))
    throw error(400, "Some cards do not belong to this project");
  return json({ ok: true });
};
