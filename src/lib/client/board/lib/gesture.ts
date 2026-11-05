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
 * Gesture measured on one axis. Card resizing uses horizontal travel so vertical motion
 * cannot activate it.
 */
export type HorizontalGesture = {
  startClientX: number;
  moved: boolean;
};

/**
 * Mark movement when either axis exceeds `threshold` from the origin. This defines a square
 * threshold region without calculating diagonal distance.
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
 * Set and return `gesture.moved` once travel crosses the threshold. Keep it true even if the
 * pointer returns to its origin.
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

/** Apply {@link markMoved} to horizontal travel only for a {@link HorizontalGesture}. */
export function markMovedHorizontally(
  gesture: HorizontalGesture,
  clientX: number,
  threshold: number = DRAG_THRESHOLD,
): boolean {
  if (Math.abs(clientX - gesture.startClientX) > threshold) gesture.moved = true;
  return gesture.moved;
}

/** Initialize pointer-origin fields with `moved` false for a new gesture. */
export function gestureOrigin(event: { clientX: number; clientY: number }): Gesture {
  return { startClientX: event.clientX, startClientY: event.clientY, moved: false };
}
