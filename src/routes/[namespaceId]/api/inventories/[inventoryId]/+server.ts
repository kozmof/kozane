import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteInventory, updateInventory } from "$db/api/inventory";
import { optionalBoundedName, optionalNumber, readJsonObject } from "../../../lib/request.js";
import { clampToCanvas } from "$lib/server/canvas";
import { apiHandler } from "../../../lib/api-handler.js";

export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
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

  return json(
    await updateInventory({
      db,
      namespaceId,
      inventoryId,
      name,
      ...(posX !== undefined && posY !== undefined && { position: clampToCanvas(posX, posY) }),
    }),
  );
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, inventoryId } = params;

  // Its cards go back where they were on the canvas. Their IDs let the board draw them
  // there without waiting for the next poll.
  return json(await deleteInventory({ db, namespaceId, inventoryId }));
});
