import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteWarp, moveWarp } from "$db/api/warp";
import { readJsonObject, optionalNumber } from "../../../lib/request.js";
import { clampToCanvas } from "$lib/server/canvas";
import { apiHandler } from "../../../lib/api-handler.js";

export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, warpId } = params;
  const body = await readJsonObject(request);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined) throw error(400, "posX and posY are required");

  // Round and clamp moved warps using the same rules as newly created warps.
  const clamped = clampToCanvas(posX, posY);
  const stored = { posX: Math.round(clamped.posX), posY: Math.round(clamped.posY) };

  return json(await moveWarp({ db, namespaceId, warpId, ...stored }));
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, warpId } = params;

  await deleteWarp({ db, namespaceId, warpId });
  return json({ ok: true });
});
