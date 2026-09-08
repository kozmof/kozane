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
 * The keys the browser UI moves between warps with, on their own and with `Shift` for the
 * warp palette. Reserved: a shortcut bound to one of these would fire alongside the jump
 * the same press makes, so `ui.*Shortcut` may not take them.
 */
export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

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
