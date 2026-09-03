import { describe, it, expect } from "vitest";
import { inset, rectCenter, squarify, type Rect, type TreemapCell } from "./treemap.js";

const AREA: Rect = { x: 0, y: 0, width: 400, height: 300 };
const item = (id: string, value: number) => ({ id, value });
const areaOf = ({ rect }: TreemapCell) => rect.width * rect.height;
const byId = (cells: TreemapCell[]) => Object.fromEntries(cells.map((c) => [c.item.id, c]));

/** Whether two rectangles share any area. Touching edges do not overlap. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width - 1e-6 &&
    b.x < a.x + a.width - 1e-6 &&
    a.y < b.y + b.height - 1e-6 &&
    b.y < a.y + a.height - 1e-6
  );
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - 1e-6 &&
  inner.y >= outer.y - 1e-6 &&
  inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-6;

describe("squarify", () => {
  it("gives every item a rectangle", () => {
    const cells = squarify([item("a", 3), item("b", 2), item("c", 1)], AREA);
    expect(cells.map((c) => c.item.id).sort()).toEqual(["a", "b", "c"]);
  });

  /** The one thing a treemap promises. */
  it("gives area in proportion to value", () => {
    const cells = byId(squarify([item("a", 6), item("b", 3), item("c", 1)], AREA));
    const total = AREA.width * AREA.height;
    expect(areaOf(cells.a)).toBeCloseTo(total * 0.6, 4);
    expect(areaOf(cells.b)).toBeCloseTo(total * 0.3, 4);
    expect(areaOf(cells.c)).toBeCloseTo(total * 0.1, 4);
  });

  it("fills the area and leaves no two cells overlapping", () => {
    const cells = squarify(
      [item("a", 7), item("b", 5), item("c", 4), item("d", 2), item("e", 2), item("f", 1)],
      AREA,
    );
    expect(cells.reduce((sum, c) => sum + areaOf(c), 0)).toBeCloseTo(AREA.width * AREA.height, 3);
    for (const cell of cells) expect(contains(AREA, cell.rect)).toBe(true);
    for (const [i, a] of cells.entries()) {
      for (const b of cells.slice(i + 1)) expect(overlaps(a.rect, b.rect)).toBe(false);
    }
  });

  /** Squarifying is order-dependent, and the page packs twice — once on the server and once
   *  in the browser. Equal values must not be left to decide it. */
  it("packs equal values the same way whatever order they arrive in", () => {
    const items = [item("b", 5), item("a", 5), item("c", 5)];
    const forwards = squarify(items, AREA);
    const backwards = squarify([...items].reverse(), AREA);
    expect(backwards).toEqual(forwards);
    expect(forwards.map((c) => c.item.id)).toEqual(["a", "b", "c"]);
  });

  it("is square-ish rather than a run of slivers", () => {
    const cells = squarify(
      Array.from({ length: 12 }, (_, i) => item(`i${i}`, 12 - i)),
      { x: 0, y: 0, width: 600, height: 400 },
    );
    for (const { rect } of cells) {
      const ratio = Math.max(rect.width / rect.height, rect.height / rect.width);
      expect(ratio).toBeLessThan(6);
    }
  });

  describe("items with no value", () => {
    it("draws an empty bundle in the strip instead of dropping it", () => {
      const cells = byId(squarify([item("full", 10), item("empty", 0)], AREA));
      expect(cells.empty.empty).toBe(true);
      expect(cells.empty.rect.height).toBeGreaterThan(0);
      expect(cells.full.empty).toBe(false);
    });

    it("keeps the proportions of everything else exact", () => {
      const cells = byId(squarify([item("a", 3), item("b", 1), item("zero", 0)], AREA));
      // The strip takes its height off the top of the packing, so the two share what is
      // left in the same 3:1 they would have shared the whole of.
      expect(areaOf(cells.a) / areaOf(cells.b)).toBeCloseTo(3, 4);
      expect(cells.zero.rect.y).toBeGreaterThan(cells.a.rect.y);
    });

    it("never lets the strip take more than a quarter of the height", () => {
      const cells = squarify(
        [item("full", 10), ...Array.from({ length: 40 }, (_, i) => item(`e${i}`, 0))],
        AREA,
      );
      const strip = cells.filter((c) => c.empty);
      expect(strip).toHaveLength(40);
      expect(strip[0].rect.height).toBeLessThanOrEqual(AREA.height * 0.25 + 1e-6);
    });

    it("gives the whole area to the strip when nothing has any value", () => {
      const cells = squarify([item("a", 0), item("b", 0)], AREA);
      expect(cells.every((c) => c.empty)).toBe(true);
      expect(cells.reduce((sum, c) => sum + areaOf(c), 0)).toBeCloseTo(AREA.width * AREA.height, 4);
    });
  });

  it("answers with nothing for no items or no room", () => {
    expect(squarify([], AREA)).toEqual([]);
    expect(squarify([item("a", 1)], { x: 0, y: 0, width: 0, height: 300 })).toEqual([]);
  });
});

describe("inset", () => {
  it("pulls each side in by its own amount", () => {
    expect(inset(AREA, { top: 10, left: 5, right: 5, bottom: 20 })).toEqual({
      x: 5,
      y: 10,
      width: 390,
      height: 270,
    });
  });

  it("collapses rather than turning inside out", () => {
    const collapsed = inset({ x: 0, y: 0, width: 10, height: 10 }, { left: 20, right: 20 });
    expect(collapsed.width).toBe(0);
  });
});

describe("rectCenter", () => {
  it("is the middle of the rectangle", () => {
    expect(rectCenter(AREA)).toEqual({ x: 200, y: 150 });
  });
});
