import { getUiConfigForRoot, getWorkspaceUiConfig } from "../../db/internal/config.js";
import { clamp } from "../constants.js";

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
