import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { takeCards } from "$db/api/inventory";
import type { TakenCard } from "$lib/inventory";
import {
  optionalNumber,
  readJsonObject,
  requireObjectArray,
  requireString,
  requireUniqueStrings,
} from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";
import { clampToCanvas } from "$lib/server/canvas";

/** Puts stored cards back on the canvas, at a given position or where they were before. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cards = requireObjectArray(body, "cards", (item): TakenCard => {
    const cardId = requireString(item, "cardId");
    const posX = optionalNumber(item, "posX");
    const posY = optionalNumber(item, "posY");
    if ((posX === undefined) !== (posY === undefined))
      throw error(400, "posX and posY must be sent together");
    return posX === undefined || posY === undefined
      ? { cardId }
      : { cardId, ...clampToCanvas(posX, posY) };
  });
  requireUniqueStrings(
    cards.map(({ cardId }) => cardId),
    "cards",
  );

  const result = await takeCards({ db, namespaceId, cards });
  if (!result.ok) rejectBatch(result.reason);
  // The stored positions, so a board that sent a fractional drop point can draw what was kept.
  return json({ cards });
};
