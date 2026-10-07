/**
 * Canvas dimensions, gesture thresholds, and warp hint limits. Import these through the
 * shared constants module.
 */
export const CANVAS_W = 5600;
export const CANVAS_H = 4000;

/**
 * A complete rectangle in board coordinates, with `posX`, `posY`, `width`, and `height`.
 * Scope-area storage, request validation, bounds checks, and drag state share this type.
 * Callers must supply all four values, not a position or size delta.
 *
 * Keep the type in this dependency-free module so database and browser code can import it.
 * `lib/types.ts` already depends on the database API.
 *
 * Keep `PositionedCardSize` separate because it describes a card's drawn box. The `BoardRect`
 * name also avoids the DOM's unrelated `CanvasRect` type.
 */
export type BoardRect = { posX: number; posY: number; width: number; height: number };

/**
 * Reserve these keys for warp navigation and, with Shift, the warp palette. Reject them in
 * `ui.*Shortcut` to prevent one press from triggering both actions.
 */
export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

/**
 * Minimum frame size in canvas pixels. Keep enough room to distinguish the drag header from
 * the resize handle.
 */
export const SCOPE_AREA_MIN_SIZE = 120;

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

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Maximum warp hint length. The palette truncates hints to fit one row, and database readers
 * use this limit to bound the source text they fetch.
 */
export const WARP_HINT_MAX_CHARS = 48;
