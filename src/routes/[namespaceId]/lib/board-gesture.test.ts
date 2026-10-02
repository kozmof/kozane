import { describe, expect, it } from "vitest";
import {
  draggedAreaId,
  draggedCardId,
  draggedWarpId,
  holdsPositionActivity,
  resizedAreaId,
  type BoardGesture,
} from "./board-gesture.js";

const origin = { startClientX: 0, startClientY: 0, moved: false };

const cardDrag: BoardGesture = {
  kind: "card-drag",
  ...origin,
  cardId: "card-1",
  offsetX: 0,
  offsetY: 0,
  prevX: 0,
  prevY: 0,
  lastX: 0,
  lastY: 0,
  groupIds: [],
  groupIdSet: new Set(),
  groupPrevPositions: new Map(),
  areaMembersBefore: new Map(),
  pointer: { x: 0, y: 0 },
};

const warpDrag: BoardGesture = {
  kind: "warp-drag",
  ...origin,
  warpId: "warp-1",
  offsetX: 0,
  offsetY: 0,
  prevX: 0,
  prevY: 0,
};

const areaDrag: BoardGesture = {
  kind: "area-drag",
  ...origin,
  areaId: "area-1",
  scopeId: "scope-1",
  prevRect: { posX: 0, posY: 0, width: 10, height: 10 },
  cardIds: [],
  cardIdSet: new Set(),
  cardPrevPositions: new Map(),
  membersBefore: new Set(),
};

const areaResize: BoardGesture = {
  kind: "area-resize",
  ...origin,
  areaId: "area-2",
  scopeId: "scope-1",
  startRect: { posX: 0, posY: 0, width: 10, height: 10 },
  membersBefore: new Set(),
  pointer: null,
};

const cardResize: BoardGesture = {
  kind: "card-resize",
  startClientX: 0,
  moved: false,
  cardId: "card-2",
  startWidth: 240,
  prevWidth: null,
  pointerX: null,
};

const marquee: BoardGesture = { kind: "marquee", ...origin, startWorldX: 0, startWorldY: 0 };
const areaDraw: BoardGesture = { kind: "area-draw", ...origin, startWorldX: 0, startWorldY: 0 };
const pan: BoardGesture = { kind: "pan", startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 };

/** Every member, so the cases below cannot quietly stop covering one. */
const every: BoardGesture[] = [
  cardDrag,
  cardResize,
  warpDrag,
  areaDrag,
  areaResize,
  marquee,
  areaDraw,
  pan,
];

describe("holdsPositionActivity", () => {
  it("is true for the gestures that move or resize something", () => {
    // These five reserve position activity at the press, which is what stands the snapshot
    // poll down so it cannot overwrite the board mid-drag.
    expect(holdsPositionActivity("card-drag")).toBe(true);
    expect(holdsPositionActivity("card-resize")).toBe(true);
    expect(holdsPositionActivity("warp-drag")).toBe(true);
    expect(holdsPositionActivity("area-drag")).toBe(true);
    expect(holdsPositionActivity("area-resize")).toBe(true);
  });

  it("is false for the gestures that change nothing while they are open", () => {
    // A marquee, a frame being drawn and a pan all leave the data alone, so a poll landing
    // during one has nothing to clobber.
    expect(holdsPositionActivity("marquee")).toBe(false);
    expect(holdsPositionActivity("area-draw")).toBe(false);
    expect(holdsPositionActivity("pan")).toBe(false);
  });

  it("answers for every member of the union", () => {
    for (const gesture of every) {
      expect(typeof holdsPositionActivity(gesture.kind)).toBe("boolean");
    }
  });
});

describe("the id readers", () => {
  it("name the subject of their own gesture", () => {
    expect(draggedCardId(cardDrag)).toBe("card-1");
    expect(draggedWarpId(warpDrag)).toBe("warp-1");
    expect(draggedAreaId(areaDrag)).toBe("area-1");
    expect(resizedAreaId(areaResize)).toBe("area-2");
  });

  it("are null when no gesture is open", () => {
    expect(draggedCardId(null)).toBeNull();
    expect(draggedWarpId(null)).toBeNull();
    expect(draggedAreaId(null)).toBeNull();
    expect(resizedAreaId(null)).toBeNull();
  });

  it("are null for every gesture that is not theirs", () => {
    // The property the four `$state` variables these replace could not have: exactly one of
    // them can be non-null, because there is one slot for them all to read.
    for (const gesture of every) {
      const named = [
        draggedCardId(gesture),
        draggedWarpId(gesture),
        draggedAreaId(gesture),
        resizedAreaId(gesture),
      ].filter((id) => id !== null);
      expect(named.length).toBeLessThanOrEqual(1);
    }
  });

  it("do not confuse a frame being dragged with one being resized", () => {
    expect(draggedAreaId(areaResize)).toBeNull();
    expect(resizedAreaId(areaDrag)).toBeNull();
  });

  it("do not confuse a card drag with a card resize", () => {
    expect(draggedCardId(cardResize)).toBeNull();
  });
});
