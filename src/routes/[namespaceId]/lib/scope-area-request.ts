import { error } from "@sveltejs/kit";
import { optionalNumber } from "./request.js";
import type { BoardRect } from "$lib/constants";

// The board's rectangle, named in `lib/constants/canvas.ts`. Kept exported under this name
// because the two endpoints and their tests already import `AreaRect` from here, and at a
// request boundary "the area's rectangle" is what it is.
export type AreaRect = BoardRect;

/**
 * Read the complete rectangle shared by scope-area creation and update requests. Report
 * missing or invalid coordinates as 400 errors. Neither endpoint accepts a delta.
 */
export function readAreaRect(body: Record<string, unknown>): AreaRect {
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  const width = optionalNumber(body, "width");
  const height = optionalNumber(body, "height");
  if (posX === undefined || posY === undefined || width === undefined || height === undefined) {
    throw error(400, "posX, posY, width and height are required");
  }
  return { posX, posY, width, height };
}
