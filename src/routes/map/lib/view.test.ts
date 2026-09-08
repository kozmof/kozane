import { describe, it, expect } from "vitest";
import {
  clampView,
  DEFAULT_ZOOM,
  defaultView,
  FITTED_VIEW,
  isDefaultView,
  pannedBy,
  viewedArea,
  zoomedBy,
  zoomedTo,
  zoomPercent,
  type MapView,
} from "./view.js";
import { buildMapLayout, type LayoutPartition } from "./map-layout.js";

const SIZE = { width: 1200, height: 800 };

describe("viewedArea", () => {
  it("is the box itself when the map is fitted to it", () => {
    expect(viewedArea(SIZE, FITTED_VIEW)).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it("grows with the zoom and moves with the pan", () => {
    expect(viewedArea(SIZE, { zoom: 2, panX: -100, panY: -50 })).toEqual({
      x: -100,
      y: -50,
      width: 2400,
      height: 1600,
    });
  });
});

describe("zoomedTo", () => {
  it("leaves the point under the pointer where it was", () => {
    const at = { x: 300, y: 200 };
    const before = viewedArea(SIZE, FITTED_VIEW);
    const view = zoomedTo(FITTED_VIEW, SIZE, at, 2);
    const after = viewedArea(SIZE, view);

    // The same fraction across the map before and after — which is what "stayed put" means.
    expect((at.x - after.x) / after.width).toBeCloseTo((at.x - before.x) / before.width, 6);
    expect((at.y - after.y) / after.height).toBeCloseTo((at.y - before.y) / before.height, 6);
  });

  it("holds a different point when a different one is pointed at", () => {
    const a = zoomedTo(FITTED_VIEW, SIZE, { x: 0, y: 0 }, 2);
    const b = zoomedTo(FITTED_VIEW, SIZE, { x: 1200, y: 800 }, 2);
    expect(a.panX).not.toBeCloseTo(b.panX, 1);
  });

  it("goes back where it started when zoomed in and out about one point", () => {
    const at = { x: 420, y: 310 };
    const there = zoomedTo(FITTED_VIEW, SIZE, at, 2);
    const back = zoomedTo(there, SIZE, at, 1);
    expect(back.panX).toBeCloseTo(0, 6);
    expect(back.panY).toBeCloseTo(0, 6);
    expect(back.zoom).toBe(1);
  });

  /** The board's own limits, so one workspace has one answer to how far a view goes. */
  it("holds to the zoom range the board holds to", () => {
    expect(zoomedTo(FITTED_VIEW, SIZE, { x: 0, y: 0 }, 99).zoom).toBe(2);
    expect(zoomedTo(FITTED_VIEW, SIZE, { x: 0, y: 0 }, 0.01).zoom).toBe(0.25);
  });
});

describe("zoomedBy", () => {
  it("steps from where it is, about the middle of the box", () => {
    const view = zoomedBy(FITTED_VIEW, SIZE, 0.5);
    expect(view.zoom).toBe(1.5);
    const area = viewedArea(SIZE, view);
    expect(area.x + area.width / 2).toBeCloseTo(SIZE.width / 2, 6);
    expect(area.y + area.height / 2).toBeCloseTo(SIZE.height / 2, 6);
  });
});

describe("clampView", () => {
  const overlap = (view: MapView) => {
    const area = viewedArea(SIZE, view);
    return {
      x: Math.min(area.x + area.width, SIZE.width) - Math.max(area.x, 0),
      y: Math.min(area.y + area.height, SIZE.height) - Math.max(area.y, 0),
    };
  };

  it("leaves a fitted map alone", () => {
    expect(clampView(FITTED_VIEW, SIZE)).toEqual(FITTED_VIEW);
  });

  it("keeps a strip on screen however far it is dragged", () => {
    for (const [dx, dy] of [
      [9e4, 0],
      [-9e4, 0],
      [0, 9e4],
      [0, -9e4],
      [-9e4, -9e4],
    ]) {
      const { x, y } = overlap(pannedBy({ zoom: 2, panX: 0, panY: 0 }, SIZE, dx, dy));
      expect(x).toBeGreaterThanOrEqual(96 - 1e-6);
      expect(y).toBeGreaterThanOrEqual(96 - 1e-6);
    }
  });

  it("keeps a map smaller than the box on screen too", () => {
    const { x, y } = overlap(pannedBy({ zoom: 0.25, panX: 0, panY: 0 }, SIZE, 9e4, 9e4));
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });

  it("takes a drag to the far edge rather than off it", () => {
    expect(pannedBy(FITTED_VIEW, SIZE, 9e4, 0).panX).toBe(SIZE.width - 96);
    expect(pannedBy(FITTED_VIEW, SIZE, -9e4, 0).panX).toBe(96 - SIZE.width);
  });
});

describe("pannedBy", () => {
  it("moves the map with the pointer", () => {
    const view = pannedBy({ zoom: 2, panX: -200, panY: -100 }, SIZE, 30, -20);
    expect(view).toMatchObject({ panX: -170, panY: -120 });
  });

  /** A drag is a function of where it began and how far the pointer has gone since, so
   *  running past the edge costs nothing on the way back: bringing the pointer home brings
   *  the map with it. */
  it("returns the map when the pointer returns, however far it went first", () => {
    const start: MapView = { zoom: 2, panX: -200, panY: -100 };
    pannedBy(start, SIZE, 9e4, 9e4);
    expect(pannedBy(start, SIZE, 0, 0)).toEqual(start);
  });
});

/**
 * The property the whole approach rests on. Zooming lays the packing into a larger rectangle
 * rather than scaling a finished drawing, so it is only a zoom at all if the same workspace
 * comes out arranged the same way — a map that rearranged itself as you zoomed into it would
 * be a different map each time you looked.
 */
describe("what a zoom does to the packing", () => {
  const partition = (id: string, namespaceId: string, cards: number): LayoutPartition => ({
    id,
    namespaceId,
    name: id,
    cards,
    bg: "#fff",
    dot: "#000",
  });
  const layoutAt = (view: MapView) =>
    buildMapLayout({
      namespaces: [
        { id: "p1", name: "One" },
        { id: "p2", name: "Two" },
      ],
      partitions: [
        partition("b1", "p1", 9),
        partition("b2", "p1", 4),
        partition("b3", "p1", 1),
        partition("b4", "p2", 6),
      ],
      scopes: [],
      area: viewedArea(SIZE, view),
    });

  it("magnifies the map rather than rearranging it", () => {
    const fitted = layoutAt(FITTED_VIEW);
    const zoomed = layoutAt({ zoom: 2, panX: 0, panY: 0 });

    // Same rectangles in the same order, and each one bigger than it was.
    expect(zoomed.partitions.map((b) => b.partition.id)).toEqual(
      fitted.partitions.map((b) => b.partition.id),
    );
    for (const [i, placed] of zoomed.partitions.entries()) {
      expect(placed.rect.width).toBeGreaterThan(fitted.partitions[i].rect.width);
    }
  });

  /** Which is the point of doing it this way: the box grows, the title band does not, so a
   *  partition too small to be labelled at 100% becomes large enough to carry one. */
  it("grows the boxes without growing what is measured in pixels", () => {
    const fitted = layoutAt(FITTED_VIEW);
    const zoomed = layoutAt({ zoom: 2, panX: 0, panY: 0 });
    const inset = (l: ReturnType<typeof layoutAt>) => {
      const namespace = l.namespaces.find(({ id }) => id === "p1")!;
      const first = l.partitions.find((b) => b.partition.namespaceId === "p1")!;
      return first.rect.y - namespace.rect.y;
    };
    expect(inset(zoomed)).toBeCloseTo(inset(fitted), 6);
  });

  it("moves the map by exactly the pan", () => {
    const at = layoutAt({ zoom: 1, panX: 40, panY: -25 });
    const fitted = layoutAt(FITTED_VIEW);
    const a = at.rects.get("b1")!;
    const b = fitted.rects.get("b1")!;
    expect(a.x - b.x).toBeCloseTo(40, 6);
    expect(a.y - b.y).toBeCloseTo(-25, 6);
    expect(a.width).toBeCloseTo(b.width, 6);
  });
});

describe("defaultView", () => {
  /** Half the box in each direction, which is a quarter of the area — the rectangles are
   *  drawn at half the size the box would fit them at. */
  it("lays the packing out at half the size of the box", () => {
    const area = viewedArea(SIZE, defaultView(SIZE));
    expect(area.width).toBe(SIZE.width * DEFAULT_ZOOM);
    expect(area.height).toBe(SIZE.height * DEFAULT_ZOOM);
  });

  /** Centred, not at a pan of zero: the map would otherwise open in the top-left corner with
   *  the tag panel across it and the rest of the window empty. */
  it("centres it, leaving the same margin on both sides", () => {
    const area = viewedArea(SIZE, defaultView(SIZE));
    expect(area.x).toBeCloseTo(SIZE.width - (area.x + area.width), 6);
    expect(area.y).toBeCloseTo(SIZE.height - (area.y + area.height), 6);
  });

  /** Centring is a function of the box, which is what lets the server centre in one size and
   *  the browser re-centre in the size it measured. */
  it("centres in whatever box it is given", () => {
    const wide = viewedArea(
      { width: 2400, height: 600 },
      defaultView({ width: 2400, height: 600 }),
    );
    expect(wide.x).toBeCloseTo(2400 - (wide.x + wide.width), 6);
    expect(wide.y).toBeCloseTo(600 - (wide.y + wide.height), 6);
  });

  /** The pan it opens at is one the clamp already allows, so the map does not jump on the
   *  first thing that touches it. */
  it("opens at a view the clamp leaves alone", () => {
    expect(clampView(defaultView(SIZE), SIZE)).toEqual(defaultView(SIZE));
  });
});

describe("zoomPercent", () => {
  /** The whole point: a map nobody has touched reads 100%, not a fraction of a view nobody
   *  has been shown. */
  it("calls the size the map opens at 100%", () => {
    expect(zoomPercent(defaultView(SIZE).zoom)).toBe(100);
  });

  it("calls the box's own fit 200%, since the map opens at half of it", () => {
    expect(zoomPercent(FITTED_VIEW.zoom)).toBe(200);
  });

  /** The band `clampZoom` allows, read in this page's units. */
  it("reads the allowed range as 50% to 400%", () => {
    expect(zoomPercent(0.25)).toBe(50);
    expect(zoomPercent(2)).toBe(400);
  });

  it("rises with the zoom and never reports a fraction of a percent", () => {
    expect(zoomPercent(0.55)).toBe(110);
    expect(zoomPercent(0.6)).toBe(120);
    expect(Number.isInteger(zoomPercent(0.37))).toBe(true);
  });
});

describe("isDefaultView", () => {
  const size = { width: 1600, height: 1000 };

  it("is true of the view the map opens at", () => {
    expect(isDefaultView(defaultView(size), size)).toBe(true);
  });

  it("is true of a view panned away and back by hand", () => {
    const moved = pannedBy(defaultView(size), size, 40, -25);
    expect(isDefaultView(moved, size)).toBe(false);
    expect(isDefaultView(pannedBy(moved, size, -40, 25), size)).toBe(true);
  });

  it("is false once the map has been zoomed", () => {
    expect(isDefaultView(zoomedBy(defaultView(size), size, 1), size)).toBe(false);
  });

  it("compares against the clamped default, so a box too small still has a way home", () => {
    // Unclamped, the default of a tiny box is a pan the clamp would not allow, and nothing
    // the user could reach would ever compare equal to it — leaving "back to the map"
    // offered forever.
    const tiny = { width: 40, height: 30 };
    expect(isDefaultView(clampView(defaultView(tiny), tiny), tiny)).toBe(true);
  });
});
