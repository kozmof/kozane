import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScopeArea } from "$db/api/scope-area";
import { isForeignKeyError } from "$db/api/utils";
import { readJsonObject } from "../../../../lib/request.js";
import { readAreaRect } from "../../../../lib/scope-area-request.js";
import { clampRectToCanvas } from "$lib/server/canvas";

/**
 * Draws another frame for this scope on this board.
 *
 * A collection, not a singleton: a scope may be framed in several places at once, so this
 * adds one rather than replacing whatever was there. Moving or removing a particular frame
 * goes to `areas/[areaId]`.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, scopeId } = params;
  const rect = readAreaRect(await readJsonObject(request));

  try {
    // The whole stored row, so a client that drew the frame where the pointer let go cannot
    // keep it at an unclamped rectangle until the next snapshot poll corrects it.
    return json(await addScopeArea({ db, namespaceId, scopeId, ...clampRectToCanvas(rect) }));
  } catch (e) {
    if (isForeignKeyError(e)) throw error(404, "Scope not found");
    throw e;
  }
};
