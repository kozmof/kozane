/**
 * The board itself: how big it is, how it is moved about, and how a warp names a place on it.
 *
 * Split out of the single `lib/constants.ts` these all used to share. That file was
 * imported by nearly every module in the tree and held the canvas beside SQLite's parameter
 * ceiling beside the tag grammar's segment length — one file to open for any of them, and one
 * file edited for reasons that had nothing to do with each other. `lib/constants.ts` is now a
 * barrel over these, so every existing import still names the same thing.
 */
export const CANVAS_W = 5600;
export const CANVAS_H = 4000;

/**
 * A complete rectangle in board coordinates, with `posX` , `posY` , `width` , and `height` .
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
 * The keys the browser UI moves between warps with, on their own and with `Shift` for the
 * warp palette. Reserved: a shortcut bound to one of these would fire alongside the jump
 * the same press makes, so `ui.*Shortcut` may not take them.
 */
export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

/**
 * The smallest a scope area may be drawn, in canvas pixels. A frame is grabbed by its header
 * and resized by a corner handle, and below roughly this the two overlap and the frame can no
 * longer be picked up — a rectangle that cannot be moved or grown again is a rectangle the user
 * has to delete.
 */
export const SCOPE_AREA_MIN_SIZE = 120;

/**
 * How far a scope-area draw has to travel before it is a rectangle rather than a stray click,
 * in canvas pixels. Below this the draw is abandoned and nothing is asked — an Alt-click that
 * was meant as a click should not put a prompt on screen.
 *
 * Smaller than {@link SCOPE_AREA_MIN_SIZE}, and deliberately: this is the line between "you
 * drew something" and "you slipped", while that one is the smallest frame that can still be
 * grabbed and resized afterwards. A rectangle between the two is a real draw, and is grown to
 * the minimum rather than thrown away.
 */
export const SCOPE_AREA_DRAW_MIN = 12;

/**
 * How far the pointer has to travel before a press becomes a drag, in screen pixels.
 *
 * The line between "clicked this card" and "moved this card", and it applies to every gesture
 * the board has: dragging a card, resizing one, dragging a warp, dragging a scope frame,
 * resizing one, and sweeping a marquee all arm a `moved` flag against this and commit only
 * once it is set. A press that never reaches it is a click, and a click must not write a
 * position patch for a card that is exactly where it was.
 *
 * Screen pixels rather than canvas pixels, deliberately: this is about the hand, not the
 * board, and a slip is the same slip at any zoom. Every comparison is therefore made on
 * `clientX`/`clientY` before the world transform, which is why it is not divided by `zoom`
 * anywhere.
 *
 * It was the literal `4`, written out six times in `KozaneCanvas.svelte` and declared a
 * seventh time as a local `DRAG_THRESHOLD` in the map page — seven copies of one number,
 * next to {@link SCOPE_AREA_DRAW_MIN}, which had been named and explained all along.
 *
 * Distinct from {@link SCOPE_AREA_DRAW_MIN}, which is larger and answers a different
 * question: this one asks whether the pointer moved at all, that one whether an Alt-drag
 * meant to draw a rectangle. A scope-area draw is held to the larger figure because getting
 * it wrong puts a prompt on screen, where getting this one wrong merely writes a no-op patch.
 */
export const DRAG_THRESHOLD = 4;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * How long a warp's hint may be, in characters. Hints ride in a single narrow row of the
 * warp palette, so a long card is cut rather than wrapped.
 *
 * Here rather than beside the palette code in `lib/warp-list.ts`, because both sides of the
 * hint need it and they sit on opposite sides of the app: `condense` there builds the line,
 * and `getCardMarkersByNamespaces` in `db/api/card.ts` sizes the `substr` it reads each card's
 * text with against it. A data-layer module reaching into a presentation module for a number
 * was the one import in the tree pointing that way; a leaf module is the place both can
 * reach. Same argument as {@link PATH_KINDS}.
 */
export const WARP_HINT_MAX_CHARS = 48;
