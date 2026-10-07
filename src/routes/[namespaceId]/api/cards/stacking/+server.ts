import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { reassignCardsStackOrder } from "$db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";

function requireStackDirection(body: Record<string, unknown>): "front" | "back" {
  const direction = requireString(body, "direction");
  if (direction !== "front" && direction !== "back")
    throw error(400, 'direction must be "front" or "back"');
  return direction;
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");
  const direction = requireStackDirection(body);
  const result = await reassignCardsStackOrder({ db, namespaceId, cardIds, direction });
  if (!result.ok) rejectBatch(result.reason);
  // Return each moved card's final stacking value because a glue group may span multiple
  // layers.
  return json({ ok: true, stacking: result.stacking });
};
