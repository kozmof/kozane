/** Canvas defaults and bounds shared by domain writes and readers. */
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
 * Minimum frame size in canvas pixels. Keep enough room to distinguish the drag header from
 * the resize handle.
 */
export const SCOPE_AREA_MIN_SIZE = 120;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Maximum warp hint length. The palette truncates hints to fit one row, and database readers
 * use this limit to bound the source text they fetch.
 */
export const WARP_HINT_MAX_CHARS = 48;
