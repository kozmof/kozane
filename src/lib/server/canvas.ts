import { getUiConfigForRoot, getWorkspaceUiConfig } from "../../db/internal/config.js";
import { clamp, SCOPE_AREA_MIN_SIZE } from "../constants.js";

export type CanvasBounds = { canvasWidth: number; canvasHeight: number };

/**
 * The board a stored position has to fall inside. The canvas is sized by the workspace
 * (`ui.canvasWidth` / `ui.canvasHeight`), so the built-in `CANVAS_W` / `CANVAS_H` defaults
 * are the right bound only for a workspace that has not changed them: clamping to them on
 * a larger board snaps a card or a warp back under the user, and clamping to them on a
 * smaller one leaves the position somewhere the viewport can never reach.
 */
export function canvasBounds(): CanvasBounds {
  const { canvasWidth, canvasHeight } = getWorkspaceUiConfig();
  return { canvasWidth, canvasHeight };
}

/**
 * The same board, for a caller that already holds the workspace root — the CLI, which
 * writes cards to this canvas as directly as the endpoints do and has to land them on the
 * board the browser will draw rather than on the built-in default.
 */
export function canvasBoundsForRoot(root: string): CanvasBounds {
  const { canvasWidth, canvasHeight } = getUiConfigForRoot(root);
  return { canvasWidth, canvasHeight };
}

/** A position held inside an already-resolved set of bounds. */
export function clampToBounds(
  posX: number,
  posY: number,
  { canvasWidth, canvasHeight }: CanvasBounds,
): { posX: number; posY: number } {
  return { posX: clamp(posX, 0, canvasWidth), posY: clamp(posY, 0, canvasHeight) };
}

/** A position held inside {@link canvasBounds}. */
export function clampToCanvas(posX: number, posY: number): { posX: number; posY: number } {
  return clampToBounds(posX, posY, canvasBounds());
}

export type CanvasRect = { posX: number; posY: number; width: number; height: number };

/**
 * A whole rectangle held inside the board, for a scope area: sized first, then placed.
 *
 * The size is settled before the position because the other order cannot be satisfied — a
 * rectangle pinned at its corner and then shrunk to fit is a different rectangle from the one
 * asked for, and on a board narrower than {@link SCOPE_AREA_MIN_SIZE} there is no position at
 * which the minimum fits. So the size is clamped to the minimum and to the board, and the
 * corner is then held so the far edge lands on the board too. A frame wider than the canvas
 * comes back the width of the canvas, at its origin.
 *
 * Integers throughout, because the columns are. Rounded here rather than by the caller so an
 * area cannot be stored at a fraction the client then redraws itself against.
 */
export function clampRectToBounds(rect: CanvasRect, bounds: CanvasBounds): CanvasRect {
  const { canvasWidth, canvasHeight } = bounds;
  const width = Math.round(clamp(rect.width, SCOPE_AREA_MIN_SIZE, canvasWidth));
  const height = Math.round(clamp(rect.height, SCOPE_AREA_MIN_SIZE, canvasHeight));
  return {
    width,
    height,
    posX: Math.round(clamp(rect.posX, 0, Math.max(0, canvasWidth - width))),
    posY: Math.round(clamp(rect.posY, 0, Math.max(0, canvasHeight - height))),
  };
}

/** A rectangle held inside {@link canvasBounds}. */
export function clampRectToCanvas(rect: CanvasRect): CanvasRect {
  return clampRectToBounds(rect, canvasBounds());
}
