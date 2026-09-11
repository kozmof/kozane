import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteWarp, moveWarp } from "$db/api/warp";
import { NotFoundError } from "$db/api/utils";
import { readJsonObject, optionalNumber } from "../../../lib/request.js";
import { clampToCanvas } from "$lib/server/canvas";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, warpId } = params;
  const body = await readJsonObject(request);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined) throw error(400, "posX and posY are required");

  // Clamped and rounded exactly as a new warp is: a dragged marker arrives here the same
  // way a set one does, and the columns are integers either way.
  const clamped = clampToCanvas(posX, posY);
  const stored = { posX: Math.round(clamped.posX), posY: Math.round(clamped.posY) };

  try {
    return json(await moveWarp({ db, namespaceId, warpId, ...stored }));
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, warpId } = params;

  try {
    await deleteWarp({ db, namespaceId, warpId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    throw e;
  }
  return json({ ok: true });
};
