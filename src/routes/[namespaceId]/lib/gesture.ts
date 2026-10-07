import { DRAG_THRESHOLD } from "$lib/constants";

/**
 * Track where a pointer gesture began and whether it crossed the drag threshold. Each gesture
 * keeps its own card, rectangle, or selection data alongside these shared fields.
 * `board-gesture.ts` represents which gesture is active.
 *
 * Measure movement with browser `clientX` and `clientY` coordinates before applying canvas zoom
 * or scroll. This keeps the physical drag threshold the same at every zoom level.
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
