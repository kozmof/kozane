import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getLayer } from "$db/api/layer";
import { reassignCardsToLayer } from "$db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const layerId = requireString(body, "layerId");
  const layer = await getLayer({ db, projectId, layerId });
  if (!layer) throw error(400, "Layer not found in project");
  const cardIds = requireStringArray(body, "cardIds");
  const result = await reassignCardsToLayer({ db, projectId, cardIds, layerId });
  if (!result.ok) throw error(400, "Some cards do not belong to this project");
  // Arriving cards are restacked above the target layer's own, so the client is told what
  // they ended up with rather than left holding a zIndex from the layer they came from.
  return json({ ok: true, stacking: result.stacking });
};
