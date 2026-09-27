import { error } from "@sveltejs/kit";
import { optionalNumber } from "./request.js";
import type { BoardRect } from "$lib/constants";

// The board's rectangle, named in `lib/constants/canvas.ts`. Kept exported under this name
// because the two endpoints and their tests already import `AreaRect` from here, and at a
// request boundary "the area's rectangle" is what it is.
export type AreaRect = BoardRect;

/**
 * The rectangle a scope-area request carries, or a 400 naming what was missing.
 *
 * Shared by the two endpoints that take one — creating a frame and moving it — because they
 * take exactly the same four numbers and would otherwise say so twice, in wording that could
 * drift. The rectangle is always whole: neither endpoint accepts a delta, so neither has a
 * partial form to allow.
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
