import { DRAG_THRESHOLD } from "$lib/constants";

/**
 * Where a pointer gesture began, and whether it has travelled far enough to be a drag.
 *
 * Every gesture the board has is some version of this: a press records where it started, the
 * moves that follow decide whether it counts as travel, and the release does one thing if it
 * did and another if it did not. Dragging a card, resizing one, dragging a warp, dragging a
 * scope frame, resizing one, sweeping a marquee, and drawing a frame are seven gestures over
 * one shape, and this is the shape.
 *
 * It is not a state machine and does not try to be. Each gesture carries its own substance
 * beside these three fields — which card, the rectangle it started at, who was in the frame
 * before it moved — and none of that generalises. What does generalise is the question "has
 * this moved yet", which was answered in six places by the same expression written out
 * longhand against the same unnamed `4`:
 *
 * ```ts
 * if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) state.moved = true;
 * ```
 *
 * Six copies meant six chances for one of them to be `>=`, or to compare the wrong axis, or to
 * be left behind when the figure changed — and a seventh copy of the number itself sat in
 * `routes/map/+page.svelte` as a local `DRAG_THRESHOLD`, where nothing tied it to these at all.
 *
 * Which of the gestures is open *is* a thing with one answer, and that answer lives in
 * `board-gesture.ts` as a tagged union over these two shapes. The distinction is worth
 * keeping straight: that module names the slot, this one names what a press is. Eight
 * nullable `let`s in the component used to do both jobs badly at once.
 *
 * ## Client pixels, not world pixels
 *
 * `startClientX`/`startClientY` are `clientX`/`clientY` as the browser reported them, before
 * the canvas's zoom and scroll transform. That is deliberate and it is why the name says
 * `Client`: the threshold is about whether the *hand* moved, and a slip of four pixels is the
 * same slip whether the board is drawn at half scale or double. Comparing world coordinates
 * would make a board zoomed out demand a longer drag to register one, which is backwards.
 *
 * The fields used to be spelled two ways — `startX`/`startY` on the card, warp and frame
 * drags, `startClientX`/`startClientY` on the resizes and the rectangles — for values that
 * were identical in kind and in origin. One name, so that conforming to {@link Gesture} is
 * what the compiler checks rather than what a reader notices.
 */
export type Gesture = {
  startClientX: number;
  startClientY: number;
  moved: boolean;
};

/**
 * A gesture measured on one axis only. Card resizing is the case: the handle is on the card's
 * edge and only horizontal travel means anything, so a vertical wobble must not arm it.
 */
export type HorizontalGesture = {
  startClientX: number;
  moved: boolean;
};

/**
 * Whether the pointer has travelled past `threshold` from where it started, on either axis.
 *
 * Either axis rather than the diagonal distance, which is what all six original copies did and
 * is kept on purpose: the cheaper test, and the shape it describes is a square around the
 * origin rather than a circle. The difference at four pixels is under two pixels in the
 * corners and nobody can feel it.
 */
export function travelled(
  origin: Gesture,
  clientX: number,
  clientY: number,
  threshold: number = DRAG_THRESHOLD,
): boolean {
  return (
    Math.abs(clientX - origin.startClientX) > threshold ||
    Math.abs(clientY - origin.startClientY) > threshold
  );
}

/**
 * Arms `gesture.moved` once the pointer has travelled, and answers whether it is armed now.
 *
 * Latching, never clearing: a drag that has moved stays moved even if the pointer comes back
 * to where it started, because the card went somewhere and came back and that is still an edit
 * worth saving. Every original copy had this property by construction — they only ever
 * assigned `true` — and it is written down here because a `=` where they had `||=` would be an
 * easy and very quiet way to lose it.
 *
 * Returns the flag so a caller can act on the same read, rather than mutating and then testing
 * the field again.
 */
export function markMoved(
  gesture: Gesture,
  clientX: number,
  clientY: number,
  threshold: number = DRAG_THRESHOLD,
): boolean {
  if (travelled(gesture, clientX, clientY, threshold)) gesture.moved = true;
  return gesture.moved;
}

/** {@link markMoved} for a {@link HorizontalGesture}: horizontal travel only. */
export function markMovedHorizontally(
  gesture: HorizontalGesture,
  clientX: number,
  threshold: number = DRAG_THRESHOLD,
): boolean {
  if (Math.abs(clientX - gesture.startClientX) > threshold) gesture.moved = true;
  return gesture.moved;
}

/**
 * The origin fields for a gesture starting at this pointer event, unarmed.
 *
 * Spread into whatever else the gesture carries — `{ ...gestureOrigin(e), cardId, offsetX }` —
 * so the three shared fields are written once and a state object cannot be built with
 * `moved: true` by accident.
 */
export function gestureOrigin(event: { clientX: number; clientY: number }): Gesture {
  return { startClientX: event.clientX, startClientY: event.clientY, moved: false };
}
