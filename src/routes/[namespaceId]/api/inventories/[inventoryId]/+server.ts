import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteInventory, updateInventory } from "$db/api/inventory";
import { NotFoundError } from "$db/api/utils";
import { optionalBoundedName, optionalNumber, readJsonObject } from "../../../lib/request.js";
import { clampToCanvas } from "$lib/server/canvas";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, inventoryId } = params;
  const body = await readJsonObject(request);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if ((posX === undefined) !== (posY === undefined))
    throw error(400, "posX and posY must be sent together");
  const name = optionalBoundedName(body);
  if (posX === undefined && name === undefined)
    throw error(400, "Send posX and posY, name, or both");

  try {
    return json(
      await updateInventory({
        db,
        namespaceId,
        inventoryId,
        name,
        ...(posX !== undefined && posY !== undefined && clampToCanvas(posX, posY)),
      }),
    );
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, inventoryId } = params;

  try {
    // Its cards go back where they were on the canvas. Their IDs let the board draw them
    // there without waiting for the next poll.
    return json(await deleteInventory({ db, namespaceId, inventoryId }));
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    throw e;
  }
};
