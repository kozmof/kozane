export { CANVAS_W, CANVAS_H, SCOPE_AREA_MIN_SIZE, clamp, WARP_HINT_MAX_CHARS } from "@kozane/core";
export type { BoardRect } from "@kozane/core";

/**
 * Reserve these keys for warp navigation and, with Shift, the warp palette. Reject them in
 * `ui.*Shortcut` to prevent one press from triggering both actions.
 */
export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

/**
 * Minimum drawing distance in canvas pixels before an Alt-drag creates a scope frame. Ignore
 * smaller gestures to avoid prompting after stray clicks.
 *
 * This is smaller than {@link SCOPE_AREA_MIN_SIZE}. Valid draws below that size are expanded
 * to the minimum frame size.
 */
export const SCOPE_AREA_DRAW_MIN = 12;

/**
 * Pointer distance in screen pixels required to begin a drag. Apply it before the canvas
 * transform so the threshold remains consistent at every zoom.
 *
 * Clicks below this threshold must not write position changes. Scope-frame drawing uses the
 * larger {@link SCOPE_AREA_DRAW_MIN} threshold because it also opens a prompt.
 */
export const DRAG_THRESHOLD = 4;

/** Board zoom limits, shared by the board and the map view. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;

/** Round a zoom level to whole percent and hold it within {@link ZOOM_MIN} and {@link ZOOM_MAX}. */
export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}
