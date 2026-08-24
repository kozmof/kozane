import type { RequestHandler } from "./$types";
import type { CardWithGlue } from "$lib/types";
import { json, error } from "@sveltejs/kit";
import { squashProjectCard, type SquashCardResult } from "$db/api/composite";
import { canvasBounds } from "$lib/server/canvas";
import { BATCH_MAX } from "$lib/constants";
import { readJsonObject, requireString } from "../../../lib/request.js";

type SquashFailure = Extract<SquashCardResult, { ok: false }>["reason"];

// Worth saying in the client's own words rather than behind a generic banner: each of
// these is something the user can do about the card they picked.
const FAILURE_MESSAGE: Record<SquashFailure, string> = {
  "not-found": "Card not found in project",
  indivisible: "Card text does not split into more than one card",
  "too-many": `Card text splits into more than ${BATCH_MAX} cards`,
};

/**
 * Replaces one card with a card per segment of its text. The split pattern is the server's
 * own — the same one `kozane card squash` uses — rather than anything the client sends: an
 * arbitrary regular expression from a request body is a cost this endpoint has no reason
 * to take on.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardId = requireString(body, "cardId");

  const result = await squashProjectCard({ db, projectId, cardId, ...canvasBounds() });
  if (!result.ok) throw error(400, FAILURE_MESSAGE[result.reason]);

  // Whole rows, as the create endpoint answers with: the positions were laid out and
  // clamped here, so a client reconstructing them locally would draw the pieces somewhere
  // else until the next snapshot poll moved them. The pieces start unglued.
  return json({
    cards: result.cards.map((card) => ({ ...card, glueId: null }) satisfies CardWithGlue),
  });
};
