import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addWarp } from "../../../../db/api/warp";
import { isForeignKeyError } from "../../../../db/api/utils";
import { readJsonObject, optionalNumber } from "../../lib/request";
import { clampToCanvas } from "$lib/server/canvas";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined) throw error(400, "posX and posY are required");

  // Clamped and rounded here rather than trusted: the columns are integers, and a warp
  // outside the canvas would scroll to a place the viewport can never reach. The bound is
  // the workspace's own canvas size, which is what the browser draws.
  const clamped = clampToCanvas(posX, posY);
  const stored = { posX: Math.round(clamped.posX), posY: Math.round(clamped.posY) };

  try {
    // The whole stored row, so a client that echoed back what it sent cannot draw the
    // marker off the clamped position until the next snapshot poll corrects it.
    return json(await addWarp({ db, projectId, ...stored }));
  } catch (e) {
    if (isForeignKeyError(e)) throw error(404, "Project not found");
    throw e;
  }
};
