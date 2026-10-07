import { getUiConfigForRoot, getWorkspaceUiConfig } from "../../db/internal/config.js";
import { clamp, SCOPE_AREA_MIN_SIZE, type BoardRect } from "../constants.js";

export type CanvasBounds = { canvasWidth: number; canvasHeight: number };

/**
 * Read stored-position bounds from `ui.canvasWidth` and `ui.canvasHeight`. Using built-in
 * defaults could move cards on a larger board or leave positions unreachable on a smaller
 * one.
 */
export function canvasBounds(): CanvasBounds {
  const { canvasWidth, canvasHeight } = getWorkspaceUiConfig();
  return { canvasWidth, canvasHeight };
}

/**
 * Read canvas settings for callers that already have the workspace root, including CLI
 * writers.
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

// Re-export the shared canvas type for existing callers. Its definition lives outside server
// code so the browser can use it too.
export type { BoardRect };

/**
 * Clamp a scope rectangle's size, then its position, to the board.
 *
 * Limit the minimum size to what the canvas can hold before positioning the far edge. Round
 * values to integers to match the database columns.
 */
export function clampRectToBounds(rect: BoardRect, bounds: CanvasBounds): BoardRect {
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
export function clampRectToCanvas(rect: BoardRect): BoardRect {
  return clampRectToBounds(rect, canvasBounds());
}
