import { describe, it, expect } from "vitest";
import {
  buildMapLayout,
  tagLinks,
  LABEL_MIN_HEIGHT,
  LABEL_MIN_WIDTH,
  type LayoutPartition,
  type MapLayoutInput,
} from "./map-layout.js";

const AREA = { x: 0, y: 0, width: 1200, height: 800 };

const partition = (id: string, namespaceId: string, cards: number): LayoutPartition => ({
  id,
  namespaceId,
  name: id,
  cards,
  bg: "oklch(93% 0.055 264)",
  dot: "oklch(80% 0.21 264)",
});

const input = (over: Partial<MapLayoutInput> = {}): MapLayoutInput => ({
  namespaces: [{ id: "p1", name: "One" }],
  partitions: [partition("b1", "p1", 3), partition("b2", "p1", 1)],
  scopes: [],
  area: AREA,
  ...over,
});

const rectOf = (layout: ReturnType<typeof buildMapLayout>, id: string) => layout.rects.get(id)!;
const areaOf = (r: { width: number; height: number }) => r.width * r.height;

describe("buildMapLayout", () => {
  it("draws nothing for a workspace with no namespaces", () => {
    const layout = buildMapLayout(input({ namespaces: [], partitions: [] }));
    expect(layout.namespaces).toEqual([]);
    expect(layout.partitions).toEqual([]);
  });

  it("packs every namespace and every partition", () => {
    const layout = buildMapLayout(
      input({
        namespaces: [
          { id: "p1", name: "One" },
          { id: "p2", name: "Two" },
        ],
        partitions: [partition("b1", "p1", 3), partition("b2", "p1", 1), partition("b3", "p2", 2)],
      }),
    );
    expect(layout.namespaces.map(({ id }) => id).sort()).toEqual(["p1", "p2"]);
    expect(layout.partitions.map(({ partition: b }) => b.id).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("keeps every partition inside its own namespace", () => {
    const layout = buildMapLayout(
      input({
        namespaces: [
          { id: "p1", name: "One" },
          { id: "p2", name: "Two" },
        ],
        partitions: [partition("b1", "p1", 5), partition("b3", "p2", 2)],
      }),
    );
    for (const { partition: b, rect } of layout.partitions) {
      const parent = rectOf(layout, b.namespaceId);
      expect(rect.x).toBeGreaterThanOrEqual(parent.x - 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(parent.y - 1e-6);
      expect(rect.x + rect.width).toBeLessThanOrEqual(parent.x + parent.width + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(parent.y + parent.height + 1e-6);
    }
  });

  /** A namespace's area is the cards its partitions hold, so a busier namespace is a bigger box. */
  it("sizes a namespace by the cards its partitions hold", () => {
    const layout = buildMapLayout(
      input({
        namespaces: [
          { id: "big", name: "Big" },
          { id: "small", name: "Small" },
        ],
        partitions: [partition("b1", "big", 9), partition("b2", "small", 1)],
      }),
    );
    expect(areaOf(rectOf(layout, "big"))).toBeGreaterThan(areaOf(rectOf(layout, "small")) * 4);
  });

  it("sizes a partition by its own cards", () => {
    const layout = buildMapLayout(input());
    expect(areaOf(rectOf(layout, "b1"))).toBeGreaterThan(areaOf(rectOf(layout, "b2")));
  });

  it("draws a namespace with no cards at all rather than dropping it", () => {
    const layout = buildMapLayout(
      input({
        namespaces: [
          { id: "p1", name: "One" },
          { id: "fresh", name: "Fresh" },
        ],
      }),
    );
    const fresh = layout.namespaces.find(({ id }) => id === "fresh");
    expect(fresh?.empty).toBe(true);
    expect(fresh?.rect.height).toBeGreaterThan(0);
  });

  /** The strip is sized off the label thresholds, so what lands in it can say what it is. An
   *  unlabelled box at the foot of the map reads as belonging to no namespace at all. */
  it("leaves a namespace in the empty strip room for its own name", () => {
    const layout = buildMapLayout(
      input({
        namespaces: [
          { id: "p1", name: "One" },
          { id: "fresh", name: "Fresh" },
          { id: "fresher", name: "Fresher" },
        ],
      }),
    );
    for (const id of ["fresh", "fresher"]) {
      const placed = layout.namespaces.find((p) => p.id === id);
      expect(placed?.empty).toBe(true);
      expect(placed?.rect.height).toBeGreaterThanOrEqual(LABEL_MIN_HEIGHT);
      expect(placed?.rect.width).toBeGreaterThanOrEqual(LABEL_MIN_WIDTH);
    }
  });

  /** The strip is taller than a partition's, and the cap is what stops that mattering. */
  it("still holds the empty strip to a quarter of the map", () => {
    const layout = buildMapLayout(
      input({
        namespaces: [
          { id: "p1", name: "One" },
          ...Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, name: `E${i}` })),
        ],
      }),
    );
    const full = layout.namespaces.find(({ id }) => id === "p1")!;
    expect(full.rect.height).toBeGreaterThan(AREA.height * 0.7);
  });

  it("leaves the whole area to the packing when there are no scopes", () => {
    const layout = buildMapLayout(input());
    expect(layout.rail.height).toBe(0);
  });

  describe("the scope graph", () => {
    const withScope = () =>
      buildMapLayout(
        input({
          namespaces: [
            { id: "p1", name: "One" },
            { id: "p2", name: "Two" },
          ],
          partitions: [partition("b1", "p1", 4), partition("b3", "p2", 4)],
          scopes: [
            {
              id: "s1",
              name: "Shared",
              spokes: [
                { kind: "partition", id: "b1", cards: 2 },
                { kind: "partition", id: "b3", cards: 1 },
              ],
            },
          ],
        }),
      );

    it("reserves a rail below the packing and keeps the rectangles out of it", () => {
      const layout = withScope();
      expect(layout.rail.height).toBeGreaterThan(0);
      for (const { rect } of layout.partitions) {
        expect(rect.y + rect.height).toBeLessThanOrEqual(layout.rail.y + 1e-6);
      }
    });

    it("puts the hub in the rail with a path to each partition it reaches", () => {
      const [scope] = withScope().scopes;
      expect(scope.spokes.map(({ id }) => id).sort()).toEqual(["b1", "b3"]);
      for (const { path } of scope.spokes) expect(path.startsWith("M ")).toBe(true);
    });

    it("drops a spoke to a rectangle that is not on the map", () => {
      const layout = buildMapLayout(
        input({
          scopes: [
            {
              id: "s1",
              name: "Half here",
              spokes: [
                { kind: "partition", id: "b1", cards: 1 },
                { kind: "partition", id: "elsewhere", cards: 1 },
              ],
            },
          ],
        }),
      );
      expect(layout.scopes[0].spokes.map(({ id }) => id)).toEqual(["b1"]);
    });

    it("draws a taskspace-only scope against the namespace rectangle", () => {
      const layout = buildMapLayout(
        input({
          scopes: [
            { id: "s1", name: "Files", spokes: [{ kind: "namespace", id: "p1", cards: 0 }] },
          ],
        }),
      );
      expect(layout.scopes[0].spokes).toHaveLength(1);
      expect(layout.scopes[0].spokes[0].kind).toBe("namespace");
    });
  });

  /** The server packs at a default size and the browser repacks at the one it measured. The
   *  same workspace must give the same map, scaled — not a different arrangement. */
  it("is a function of its input alone", () => {
    expect(buildMapLayout(input())).toEqual(buildMapLayout(input()));
  });
});

describe("tagLinks", () => {
  const layout = buildMapLayout(input());

  it("draws one path per partition the tag reaches", () => {
    const links = tagLinks(
      layout,
      { x: 0, y: 100 },
      new Map([
        ["b1", 2],
        ["b2", 1],
      ]),
    );
    expect(links.map(({ id }) => id)).toEqual(["b1", "b2"]);
    for (const { path } of links) expect(path.startsWith("M 0 100 Q ")).toBe(true);
  });

  it("carries the weight through, for the line to be drawn by", () => {
    const [link] = tagLinks(layout, { x: 0, y: 100 }, new Map([["b1", 7]]));
    expect(link.cards).toBe(7);
  });

  it("says nothing about a partition that is not on the map", () => {
    expect(tagLinks(layout, { x: 0, y: 0 }, new Map([["ghost", 1]]))).toEqual([]);
  });

  it("draws nothing for a tag reaching nowhere", () => {
    expect(tagLinks(layout, { x: 0, y: 0 }, new Map())).toEqual([]);
  });
});
