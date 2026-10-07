import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScopeArea } from "$db/api/scope-area";
import { isForeignKeyError } from "$db/api/utils";
import { readJsonObject } from "../../../../lib/request.js";
import { readAreaRect } from "../../../../lib/scope-area-request.js";
import { clampRectToCanvas } from "$lib/server/canvas";

/**
 * Add a frame for this scope on this board without replacing existing frames. Move or remove
 * individual frames through `areas/[areaId]`.
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
