import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { setScopeArea, deleteScopeArea } from "$db/api/scope-area";
import { isForeignKeyError, NotFoundError } from "$db/api/utils";
import { readJsonObject, optionalNumber } from "../../../../lib/request.js";
import { clampRectToCanvas } from "$lib/server/canvas";

/**
 * Puts the scope's frame on this board, or moves and resizes the one already there.
 *
 * `PUT` rather than a `POST` to create and a `PATCH` to move: a scope has at most one area per
 * namespace, and the board has no gesture that means "add a frame" separately from "the frame
 * is here now" — the sidebar button and the end of a drag send the same whole rectangle.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, scopeId } = params;
  const body = await readJsonObject(request);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  const width = optionalNumber(body, "width");
  const height = optionalNumber(body, "height");
  if (posX === undefined || posY === undefined || width === undefined || height === undefined) {
    throw error(400, "posX, posY, width and height are required");
  }

  // Clamped and rounded here rather than trusted, for the reason `POST /api/warps` gives: the
  // columns are integers, and a frame off the board is one the viewport can never reach —
  // along with, now, every card the next drag would file into it.
  const stored = clampRectToCanvas({ posX, posY, width, height });

  try {
    // The whole stored row, so a client that drew the frame where the pointer let go cannot
    // keep it at an unclamped rectangle until the next snapshot poll corrects it.
    return json(await setScopeArea({ db, namespaceId, scopeId, ...stored }));
  } catch (e) {
    if (isForeignKeyError(e)) throw error(404, "Scope not found");
    throw e;
  }
};

/**
 * Takes the frame off this board. Memberships are deliberately untouched — see
 * {@link deleteScopeArea}.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, scopeId } = params;

  try {
    await deleteScopeArea({ db, namespaceId, scopeId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, "Scope area not found");
    throw e;
  }

  return json({ ok: true });
};
