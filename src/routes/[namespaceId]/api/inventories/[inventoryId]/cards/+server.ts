import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { stowCards } from "$db/api/inventory";
import { INVENTORY_SLOT_MAX } from "$lib/constants";
import { optionalNumber, readJsonObject, requireStringArray } from "../../../../lib/request.js";
import { rejectBatch } from "../../../../lib/rejection.js";

/** Puts cards into this inventory, from the canvas or from another inventory. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, inventoryId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");
  const slot = optionalNumber(body, "slot");
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 0 || slot > INVENTORY_SLOT_MAX))
    throw error(400, `slot must be an integer from 0 to ${INVENTORY_SLOT_MAX}`);

  const result = await stowCards({ db, namespaceId, inventoryId, cardIds, slot: slot ?? null });
  if (!result.ok) rejectBatch(result.reason);
  return json({ placements: result.placements, clearedCardIds: result.clearedCardIds });
};
