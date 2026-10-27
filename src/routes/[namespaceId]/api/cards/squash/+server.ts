import type { RequestHandler } from "./$types";
import type { CardWithGlue } from "$lib/types";
import { json, error } from "@sveltejs/kit";
import { squashNamespaceCard, type SquashCardResult } from "$db/api/composite";
import { withCardInventory } from "$db/api/card";
import { canvasBounds } from "$lib/server/canvas";
import { BATCH_MAX } from "$lib/constants";
import { readJsonObject, requireString } from "../../../lib/request.js";

type SquashFailure = Extract<SquashCardResult, { ok: false }>["reason"];

// Return actionable messages for problems with the selected card.
const FAILURE_MESSAGE: Record<SquashFailure, string> = {
  "not-found": "Card not found in namespace",
  stored: "Stored cards cannot be squashed. Take the card out of its inventory first",
  indivisible: "Card text does not split into more than one card",
  "too-many": `Card text splits into more than ${BATCH_MAX} cards`,
  "inventory-full": "Card text splits into more pieces than one inventory holds",
};

/**
 * Replace one card with a card per text segment, stored in a new inventory. Use the server's
 * shared split pattern rather than accepting arbitrary client regular expressions.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cardId = requireString(body, "cardId");

  const result = await squashNamespaceCard({ db, namespaceId, cardId, ...canvasBounds() });
  if (!result.ok) throw error(400, FAILURE_MESSAGE[result.reason]);

  // Return full stored rows so clients use the slots and return positions planned here. The
  // pieces start unglued. `stacking` names the cards raised above them.
  return json({
    inventory: result.inventory,
    cards: result.cards.map(
      (card) => ({ ...withCardInventory(card), glueId: null }) satisfies CardWithGlue,
    ),
    stacking: result.stacking,
  });
};
