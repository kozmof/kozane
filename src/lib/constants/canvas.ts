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
 * A whole rectangle in canvas coordinates: where it sits and how big it is.
 *
 * The shape a scope area is, everywhere one is passed about — stored in `scope_area`, read off
 * a request by `readAreaRect`, clamped to the board by `clampRectToBounds`, carried by
 * `createScopeArea` and `moveScopeArea`, and held in the canvas's drag and resize state.
 *
 * Named once because it had been named four times and spelled out nine more. There was
 * `CanvasRect` in `lib/server/canvas.ts`, `Rect` in `db/api/scope-area.ts`, `AreaRect` in
 * `routes/[namespaceId]/lib/scope-area-request.ts`, and the bare
 * `{ posX: number; posY: number; width: number; height: number }` written inline in the two API
 * wrappers, the two action-layer signatures, the page's prop type, and four places in
 * `KozaneCanvas.svelte`. Every one of them meant this, and structural typing meant they all
 * interoperated silently — so nothing was broken by it, and nothing would have caught a fifth
 * spelling that quietly dropped `height` either.
 *
 * Here rather than in `lib/types.ts`, for the reason {@link WARP_HINT_MAX_CHARS} and
 * `PATH_KINDS` are here: both the data layer and the browser need it, and `lib/types.ts`
 * imports from `db/api/types.js`, so putting it there would have `db/api/scope-area.ts`
 * importing back through it. A leaf module is the place both can reach without the tree gaining
 * an edge that points the wrong way.
 *
 * Always whole, never a delta. Both endpoints that take one take all four numbers, which is
 * what `readAreaRect` refuses a partial body for; a caller holding a rectangle never has to ask
 * whether it is an offset from something else.
 *
 * Distinct from `PositionedCardSize` in `routes/[namespaceId]/lib/namespace-page.ts`, which is
 * the same four numbers about a different thing — a card's drawn box rather than a frame on the
 * board. Left separate deliberately: structural identity is not the same as meaning the same
 * thing, and a function that lays cards out should not accept a scope frame because the fields
 * happen to line up.
 *
 * `Board` and not `Canvas` in the name, which matters more than it looks: `CanvasRect` is a
 * type `lib.dom.d.ts` already declares — the 2D context's `clearRect`/`fillRect`/`strokeRect`
 * mixin — so that spelling resolves to the DOM's in any module that uses it without importing
 * it, and the compiler says nothing until the two are compared. "Board" is also what the rest
 * of the project calls this surface.
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
