import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD, SCOPE_AREA_DRAW_MIN } from "$lib/constants";
import {
  gestureOrigin,
  markMoved,
  markMovedHorizontally,
  travelled,
  type Gesture,
} from "./gesture.js";

/** A gesture that began at the origin, so a coordinate reads as its own distance travelled. */
function atOrigin(): Gesture {
  return { startClientX: 0, startClientY: 0, moved: false };
}

describe("gestureOrigin", () => {
  it("records the pointer position and starts unarmed", () => {
    expect(gestureOrigin({ clientX: 120, clientY: 40 })).toEqual({
      startClientX: 120,
      startClientY: 40,
      moved: false,
    });
  });

  it("ignores everything on the event but its client coordinates", () => {
    const origin = gestureOrigin({ clientX: 1, clientY: 2, pageX: 999, button: 2 } as never);
    expect(origin).toEqual({ startClientX: 1, startClientY: 2, moved: false });
  });
});

describe("travelled", () => {
  it("is false at the origin", () => {
    expect(travelled(atOrigin(), 0, 0)).toBe(false);
  });

  it("is false exactly at the threshold, and true one pixel past it", () => {
    // The original six copies were all `> threshold`, so the boundary belongs to "not moved".
    // A test on each side because this is the one place an accidental `>=` would hide.
    expect(travelled(atOrigin(), DRAG_THRESHOLD, 0)).toBe(false);
    expect(travelled(atOrigin(), DRAG_THRESHOLD + 1, 0)).toBe(true);
  });

  it("measures each axis on its own, so either one alone is enough", () => {
    expect(travelled(atOrigin(), DRAG_THRESHOLD + 1, 0)).toBe(true);
    expect(travelled(atOrigin(), 0, DRAG_THRESHOLD + 1)).toBe(true);
  });

  it("measures distance, not direction", () => {
    expect(travelled(atOrigin(), -(DRAG_THRESHOLD + 1), 0)).toBe(true);
    expect(travelled(atOrigin(), 0, -(DRAG_THRESHOLD + 1))).toBe(true);
  });

  it("measures from where the gesture started rather than from zero", () => {
    const origin: Gesture = { startClientX: 500, startClientY: 300, moved: false };
    expect(travelled(origin, 500 + DRAG_THRESHOLD, 300)).toBe(false);
    expect(travelled(origin, 500 + DRAG_THRESHOLD + 1, 300)).toBe(true);
  });

  it("takes a threshold of its own, which is how a frame draw asks for a longer one", () => {
    // `scopeAreaDrawState` is held to SCOPE_AREA_DRAW_MIN rather than DRAG_THRESHOLD: an
    // Alt-click that was meant as a click must not open a prompt.
    const far = atOrigin();
    expect(travelled(far, DRAG_THRESHOLD + 1, 0, SCOPE_AREA_DRAW_MIN)).toBe(false);
    expect(travelled(far, SCOPE_AREA_DRAW_MIN + 1, 0, SCOPE_AREA_DRAW_MIN)).toBe(true);
  });

  it("does not arm the gesture it is asked about", () => {
    const gesture = atOrigin();
    travelled(gesture, 1000, 1000);
    expect(gesture.moved).toBe(false);
  });
});

describe("markMoved", () => {
  it("leaves a gesture that has not travelled unarmed, and answers false", () => {
    const gesture = atOrigin();
    expect(markMoved(gesture, DRAG_THRESHOLD, 0)).toBe(false);
    expect(gesture.moved).toBe(false);
  });

  it("arms a gesture that has travelled, and answers true", () => {
    const gesture = atOrigin();
    expect(markMoved(gesture, DRAG_THRESHOLD + 1, 0)).toBe(true);
    expect(gesture.moved).toBe(true);
  });

  it("latches: a pointer returning to the origin leaves it armed", () => {
    // The card went somewhere and came back, which is still an edit worth saving. An `=`
    // where this has an effective `||=` would clear it on the next move and lose the save.
    const gesture = atOrigin();
    markMoved(gesture, DRAG_THRESHOLD + 1, 0);
    expect(markMoved(gesture, 0, 0)).toBe(true);
    expect(gesture.moved).toBe(true);
  });

  it("honours a threshold of its own", () => {
    const gesture = atOrigin();
    expect(markMoved(gesture, DRAG_THRESHOLD + 1, 0, SCOPE_AREA_DRAW_MIN)).toBe(false);
    expect(markMoved(gesture, SCOPE_AREA_DRAW_MIN + 1, 0, SCOPE_AREA_DRAW_MIN)).toBe(true);
  });
});

describe("markMovedHorizontally", () => {
  it("ignores vertical travel however far it goes", () => {
    // The resize handle sits on the card's edge; only horizontal travel means anything, so a
    // press that slides straight down must not count as a resize.
    const gesture = { startClientX: 0, moved: false };
    expect(markMovedHorizontally(gesture, 0)).toBe(false);
    expect(gesture.moved).toBe(false);
  });

  it("arms on horizontal travel past the threshold, in either direction", () => {
    const widening = { startClientX: 0, moved: false };
    expect(markMovedHorizontally(widening, DRAG_THRESHOLD + 1)).toBe(true);

    const narrowing = { startClientX: 0, moved: false };
    expect(markMovedHorizontally(narrowing, -(DRAG_THRESHOLD + 1))).toBe(true);
  });

  it("is false exactly at the threshold", () => {
    const gesture = { startClientX: 0, moved: false };
    expect(markMovedHorizontally(gesture, DRAG_THRESHOLD)).toBe(false);
  });

  it("latches, as the two-axis form does", () => {
    const gesture = { startClientX: 0, moved: false };
    markMovedHorizontally(gesture, DRAG_THRESHOLD + 1);
    expect(markMovedHorizontally(gesture, 0)).toBe(true);
  });
});

describe("the thresholds themselves", () => {
  it("keeps a frame draw harder to trigger than a drag", () => {
    // The relationship the two constants are documented against: if this ever inverted, an
    // Alt-click would open a prompt more easily than a press moves a card.
    expect(SCOPE_AREA_DRAW_MIN).toBeGreaterThan(DRAG_THRESHOLD);
  });
});
