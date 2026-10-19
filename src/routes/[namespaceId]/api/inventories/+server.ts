import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addInventory } from "$db/api/inventory";
import { isForeignKeyError } from "$db/api/utils";
import { optionalBoundedName, optionalNumber, readJsonObject } from "../../lib/request.js";
import { clampToCanvas } from "$lib/server/canvas";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined) throw error(400, "posX and posY are required");
  const name = optionalBoundedName(body);

  try {
    // The whole stored row, with the position clamped to the canvas as a warp's is.
    return json(await addInventory({ db, namespaceId, name, ...clampToCanvas(posX, posY) }));
  } catch (e) {
    if (isForeignKeyError(e)) throw error(404, "Namespace not found");
    throw e;
  }
};
