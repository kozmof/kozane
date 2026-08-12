import { getWorkspaceUiConfig } from "../../db/internal/config.js";
import { clamp } from "../constants.js";

/**
 * The board a stored position has to fall inside. The canvas is sized by the workspace
 * (`ui.canvasWidth` / `ui.canvasHeight`), so the built-in `CANVAS_W` / `CANVAS_H` defaults
 * are the right bound only for a workspace that has not changed them: clamping to them on
 * a larger board snaps a card or a warp back under the user, and clamping to them on a
 * smaller one leaves the position somewhere the viewport can never reach.
 */
export function canvasBounds(): { canvasWidth: number; canvasHeight: number } {
  const { canvasWidth, canvasHeight } = getWorkspaceUiConfig();
  return { canvasWidth, canvasHeight };
}

/** A position held inside {@link canvasBounds}. */
export function clampToCanvas(posX: number, posY: number): { posX: number; posY: number } {
  const { canvasWidth, canvasHeight } = canvasBounds();
  return { posX: clamp(posX, 0, canvasWidth), posY: clamp(posY, 0, canvasHeight) };
}
