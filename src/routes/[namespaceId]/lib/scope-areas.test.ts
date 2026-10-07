import { describe, expect, it } from "vitest";
import type { ScopeArea } from "$lib/types";
import {
  areaBoardRect,
  areasByScope,
  areaWorldRect,
  cardIdsInScope,
  heldScopeAreaRect,
  membersByScope,
  sameBoardRect,
  scopeAreaChanges,
  type CardIdsInRect,
} from "./scope-areas.js";
import { SCOPE_AREA_MIN_SIZE } from "$lib/constants";
import type { WorldRect } from "./namespace-page.js";

function area(id: string, scopeId: string, posX: number, posY = 0): ScopeArea {
  return { id, scopeId, namespaceId: "ns", posX, posY, width: 100, height: 100 };
}

/** Point-sized card fixtures whose rectangle membership depends only on position. */
function boardOf(cards: Record<string, { x: number; y: number }>): CardIdsInRect {
  return (rect: WorldRect) =>
    new Set(
      Object.entries(cards)
        .filter(
          ([, p]) =>
            p.x >= rect.x && p.x < rect.x + rect.w && p.y >= rect.y && p.y < rect.y + rect.h,
        )
        .map(([id]) => id),
    );
}

describe("area rectangles", () => {
  it("reads a frame in both shapes and compares the stored one", () => {
    const a = area("a1", "s1", 10, 20);
    expect(areaWorldRect(a)).toEqual({ x: 10, y: 20, w: 100, h: 100 });
    expect(areaBoardRect(a)).toEqual({ posX: 10, posY: 20, width: 100, height: 100 });
    expect(sameBoardRect(a, areaBoardRect(a))).toBe(true);
    expect(sameBoardRect(a, { ...areaBoardRect(a), width: 101 })).toBe(false);
  });
});

describe("areasByScope", () => {
  it("groups frames by scope in board order", () => {
    const a1 = area("a1", "s1", 0);
    const a2 = area("a2", "s2", 200);
    const a3 = area("a3", "s1", 400);
    expect(areasByScope([a1, a2, a3])).toEqual(
      new Map([
        ["s1", [a1, a3]],
        ["s2", [a2]],
      ]),
    );
  });
});

describe("cardIdsInScope", () => {
  it("is the union over every frame of the scope", () => {
    const board = boardOf({ c1: { x: 50, y: 50 }, c2: { x: 450, y: 50 }, c3: { x: 250, y: 50 } });
    expect(cardIdsInScope([area("a1", "s1", 0), area("a3", "s1", 400)], board)).toEqual(
      new Set(["c1", "c2"]),
    );
  });
});

describe("membersByScope", () => {
  it("answers once per scope", () => {
    const board = boardOf({ c1: { x: 50, y: 50 }, c2: { x: 250, y: 50 } });
    const members = membersByScope([area("a1", "s1", 0), area("a2", "s2", 200)], board);
    expect(members).toEqual(
      new Map([
        ["s1", new Set(["c1"])],
        ["s2", new Set(["c2"])],
      ]),
    );
  });
});

describe("scopeAreaChanges", () => {
  const areas = [area("a1", "s1", 0), area("a2", "s1", 400), area("b1", "s2", 200)];

  it("reports cards that entered and left a scope", () => {
    const board = boardOf({ c1: { x: 250, y: 50 }, c2: { x: 50, y: 50 } });
    const before = new Map([["s1", new Set(["c1"])]]);
    expect(scopeAreaChanges(areas, before, board)).toEqual([
      { scopeId: "s1", change: { entered: ["c2"], exited: ["c1"] } },
    ]);
  });

  it("does not count a move between two frames of one scope", () => {
    const board = boardOf({ c1: { x: 450, y: 50 } });
    const before = new Map([["s1", new Set(["c1"])]]);
    expect(scopeAreaChanges(areas, before, board)).toEqual([]);
  });

  it("asks only about the scopes it was given a before for", () => {
    const board = boardOf({ c1: { x: 250, y: 50 } });
    expect(scopeAreaChanges(areas, new Map(), board)).toEqual([]);
  });
});

describe("heldScopeAreaRect", () => {
  const bounds = { canvasWidth: 1000, canvasHeight: 800 };

  it("grows a small draw to the minimum size", () => {
    expect(heldScopeAreaRect({ x: 10.4, y: 20.6, w: 5, h: 5 }, bounds)).toEqual({
      x: 10,
      y: 21,
      w: SCOPE_AREA_MIN_SIZE,
      h: SCOPE_AREA_MIN_SIZE,
    });
  });

  it("sizes first, then keeps the rectangle on the canvas", () => {
    expect(heldScopeAreaRect({ x: 950, y: 790, w: 300, h: 2000 }, bounds)).toEqual({
      x: 700,
      y: 0,
      w: 300,
      h: 800,
    });
  });
});
