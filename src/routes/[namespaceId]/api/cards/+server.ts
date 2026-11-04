import { createServiceContext } from "../../../../services/context.js";
import { create as createCard } from "../../../../services/cards.js";
import type { RequestHandler } from "./$types";

import { json } from "@sveltejs/kit";

import { updateNamespaceCardPositions, type CardPositionUpdate } from "$db/api/card";
import { deleteNamespaceCards } from "$db/api/composite";

import { clampToCanvas, canvasBounds } from "$lib/server/canvas";
import { contentMax } from "$lib/server/content-limit";
import {
  readJsonObject,
  requireFiniteNumber,
  requireObjectArray,
  requireString,
  requireStringArray,
  requireUniqueStrings,
} from "../../lib/request.js";
import { rejectBatch } from "../../lib/rejection.js";
import { apiHandler } from "../../lib/api-handler.js";

function requirePositionUpdates(body: Record<string, unknown>): CardPositionUpdate[] {
  // Each position adds parameters to both CASE expressions and WHERE. Enforce the batch cap
  // with `requireObjectArray`.
  const positions = requireObjectArray(
    body,
    "positions",
    (row) => ({
      cardId: requireString(row, "cardId"),
      // Return stored rows because incoming positions are clamped. See POST below.
      ...clampToCanvas(requireFiniteNumber(row, "posX"), requireFiniteNumber(row, "posY")),
    }),
    { message: "positions is required" },
  );

  requireUniqueStrings(
    positions.map((p) => p.cardId),
    "cardId",
  );
  return positions;
}

export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  return json(
    await createCard(
      locals.db,
      createServiceContext({ contentMax: contentMax(), ...canvasBounds() }),
      params.namespaceId,
      await readJsonObject(request),
    ),
  );
});

export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const positions = requirePositionUpdates(body);

  const result = await updateNamespaceCardPositions({ db, namespaceId, positions });
  if (!result.ok) rejectBatch(result.reason);

  return json({ ok: true });
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");
  const result = await deleteNamespaceCards({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
});
