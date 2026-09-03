import { describe, it, expect } from "vitest";
import {
  curve,
  placeHubs,
  rectAnchor,
  scopeRail,
  scopeRailRows,
  tagBundleTargets,
  HUB_RADIUS,
} from "./graph.js";
import type { Rect } from "./treemap.js";

const AREA: Rect = { x: 0, y: 0, width: 1200, height: 800 };
const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

describe("scopeRail", () => {
  it("takes no room at all when there are no scopes", () => {
    expect(scopeRail(0, AREA).height).toBe(0);
    expect(scopeRailRows(0, AREA)).toBe(0);
  });

  it("sits along the bottom of the area", () => {
    const rail = scopeRail(3, AREA);
    expect(rail.y + rail.height).toBeCloseTo(AREA.y + AREA.height, 6);
    expect(rail.width).toBe(AREA.width);
  });

  it("adds a row once one row cannot hold them all", () => {
    expect(scopeRailRows(4, AREA)).toBe(1);
    expect(scopeRailRows(30, AREA)).toBeGreaterThan(1);
  });

  it("never takes more than a share of the map, however many scopes there are", () => {
    expect(scopeRail(500, AREA).height).toBeLessThanOrEqual(AREA.height * 0.4);
  });
});

describe("placeHubs", () => {
  const rail = scopeRail(3, AREA);

  it("puts a hub under the middle of what it reaches", () => {
    const [hub] = placeHubs(
      [
        {
          id: "s",
          toward: [
            { x: 200, y: 100 },
            { x: 400, y: 100 },
          ],
        },
      ],
      rail,
    );
    expect(hub.point.x).toBeCloseTo(300, 6);
    expect(hub.point.y).toBeGreaterThan(rail.y);
    expect(hub.point.y).toBeLessThan(rail.y + rail.height);
  });

  it("centres a hub with nothing to reach", () => {
    const [hub] = placeHubs([{ id: "s", toward: [] }], rail);
    expect(hub.point.x).toBeCloseTo(AREA.width / 2, 6);
  });

  it("keeps two scopes over the same bundles apart", () => {
    const toward = [{ x: 600, y: 100 }];
    const hubs = placeHubs(
      [
        { id: "a", toward },
        { id: "b", toward },
      ],
      rail,
    );
    const [a, b] = hubs.map(({ point }) => point.x).sort((x, y) => x - y);
    expect(b - a).toBeGreaterThanOrEqual(2 * HUB_RADIUS);
  });

  it("stays inside the rail even when every scope wants the same edge", () => {
    const hubs = placeHubs(
      Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, toward: [{ x: 1190, y: 10 }] })),
      scopeRail(8, AREA),
    );
    for (const { point } of hubs) {
      expect(point.x).toBeGreaterThanOrEqual(AREA.x);
      expect(point.x).toBeLessThanOrEqual(AREA.x + AREA.width);
    }
  });

  /** Past the rail's own ceiling there are more hubs than rows to give them the gap they
   *  ask for. They are drawn tighter, and still on the map. */
  it("stays on the map when there are more scopes than the rail has room for", () => {
    const narrow = { x: 0, y: 0, width: 300, height: 800 };
    const hubs = placeHubs(
      Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, toward: [{ x: i * 7, y: 10 }] })),
      scopeRail(40, narrow),
    );
    expect(hubs).toHaveLength(40);
    for (const { point } of hubs) {
      expect(point.x).toBeGreaterThanOrEqual(narrow.x);
      expect(point.x).toBeLessThanOrEqual(narrow.x + narrow.width);
    }
  });

  it("places every scope exactly once, whatever order they arrive in", () => {
    const hubs = [
      { id: "c", toward: [{ x: 900, y: 10 }] },
      { id: "a", toward: [{ x: 100, y: 10 }] },
      { id: "b", toward: [{ x: 500, y: 10 }] },
    ];
    const forwards = placeHubs(hubs, rail);
    const backwards = placeHubs([...hubs].reverse(), rail);
    expect(forwards.map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
    expect(new Map(backwards.map((h) => [h.id, h.point]))).toEqual(
      new Map(forwards.map((h) => [h.id, h.point])),
    );
  });

  it("answers with nothing when there is no rail to place them in", () => {
    expect(placeHubs([{ id: "s", toward: [] }], scopeRail(0, AREA))).toEqual([]);
  });
});

describe("rectAnchor", () => {
  const box = rect(100, 100, 200, 100); // centre (200, 150)

  it("stops on the border rather than at the centre", () => {
    const anchor = rectAnchor(box, { x: 200, y: 400 });
    expect(anchor).toEqual({ x: 200, y: 200 });
  });

  it("leaves by the side the line is heading for", () => {
    expect(rectAnchor(box, { x: 900, y: 150 })).toEqual({ x: 300, y: 150 });
    expect(rectAnchor(box, { x: -900, y: 150 })).toEqual({ x: 100, y: 150 });
  });

  it("lands on the border for a diagonal, not past it", () => {
    const { x, y } = rectAnchor(box, { x: 1000, y: 1000 });
    expect(x).toBeLessThanOrEqual(300 + 1e-6);
    expect(y).toBeLessThanOrEqual(200 + 1e-6);
    expect(x === 300 || y === 200).toBe(true);
  });

  it("answers with the centre when asked about the centre", () => {
    expect(rectAnchor(box, { x: 200, y: 150 })).toEqual({ x: 200, y: 150 });
  });
});

describe("curve", () => {
  it("runs between the two points it was given", () => {
    const path = curve({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(path.startsWith("M 0 0 Q ")).toBe(true);
    expect(path.endsWith(" 100 0")).toBe(true);
  });

  it("bows to one side rather than running straight through the middle", () => {
    const path = curve({ x: 0, y: 0 }, { x: 100, y: 0 });
    const [, controlY] = path
      .match(/Q (-?[\d.]+) (-?[\d.]+)/)!
      .slice(1)
      .map(Number);
    expect(controlY).not.toBe(0);
  });
});

describe("tagBundleTargets", () => {
  const index = {
    perf: { b1: 2 },
    "perf:cache": { b1: 1, b2: 3 },
    "perf:cache:invalidation": { b3: 1 },
    "perf:disk": { b5: 4 },
    docs: { b4: 5 },
  };

  it("gathers a tag's own bundles and everything under it", () => {
    expect([...tagBundleTargets(index, "perf").keys()].sort()).toEqual(["b1", "b2", "b3", "b5"]);
  });

  it("gathers a subcategory without its parent's other branches", () => {
    expect([...tagBundleTargets(index, "perf:cache").keys()].sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("adds the weight of every level that reaches one bundle", () => {
    expect(tagBundleTargets(index, "perf").get("b1")).toBe(3);
  });

  it("matches by level, not by characters", () => {
    expect(tagBundleTargets({ perfect: { b9: 1 } }, "perf").size).toBe(0);
  });

  it("normalizes the tag it is asked about", () => {
    expect([...tagBundleTargets(index, "PERF:Cache").keys()].sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("answers with nothing for a tag nothing carries", () => {
    expect(tagBundleTargets(index, "ghost").size).toBe(0);
  });
});
