import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { reassignCardsToLayer } from "$db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const layerId = requireString(body, "layerId");
  const cardIds = requireStringArray(body, "cardIds");
  // No `getLayer` first; see the note in the sibling bundle handler.
  const result = await reassignCardsToLayer({ db, projectId, cardIds, layerId });
  if (!result.ok) rejectBatch(result.reason);
  // Arriving cards are restacked above the target layer's own, so the client is told what
  // they ended up with rather than left holding a zIndex from the layer they came from.
  return json({ ok: true, stacking: result.stacking });
};
