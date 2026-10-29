import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addInventory } from "$db/api/inventory";
import { optionalBoundedName, optionalNumber, readJsonObject } from "../../lib/request.js";
import { clampToCanvas } from "$lib/server/canvas";
import { apiHandler } from "../../lib/api-handler.js";

export const POST: RequestHandler = apiHandler(
  async ({ locals, params, request }) => {
    const { db } = locals;
    const { namespaceId } = params;
    const body = await readJsonObject(request);
    const posX = optionalNumber(body, "posX");
    const posY = optionalNumber(body, "posY");
    if (posX === undefined || posY === undefined) throw error(400, "posX and posY are required");
    const name = optionalBoundedName(body);

    // The whole stored row, with the position clamped to the canvas as a warp's is.
    return json(await addInventory({ db, namespaceId, name, ...clampToCanvas(posX, posY) }));
  },
  { foreignKey: "Namespace not found" },
);
