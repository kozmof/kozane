import { describe, it, expect } from "vitest";
import { buildMapLayout, tagLinks, type LayoutBundle, type MapLayoutInput } from "./layout.js";

const AREA = { x: 0, y: 0, width: 1200, height: 800 };

const bundle = (id: string, projectId: string, cards: number): LayoutBundle => ({
  id,
  projectId,
  name: id,
  cards,
  bg: "oklch(93% 0.055 264)",
  dot: "oklch(80% 0.21 264)",
});

const input = (over: Partial<MapLayoutInput> = {}): MapLayoutInput => ({
  projects: [{ id: "p1", name: "One" }],
  bundles: [bundle("b1", "p1", 3), bundle("b2", "p1", 1)],
  scopes: [],
  area: AREA,
  ...over,
});

const rectOf = (layout: ReturnType<typeof buildMapLayout>, id: string) => layout.rects.get(id)!;
const areaOf = (r: { width: number; height: number }) => r.width * r.height;

describe("buildMapLayout", () => {
  it("draws nothing for a workspace with no projects", () => {
    const layout = buildMapLayout(input({ projects: [], bundles: [] }));
    expect(layout.projects).toEqual([]);
    expect(layout.bundles).toEqual([]);
  });

  it("packs every project and every bundle", () => {
    const layout = buildMapLayout(
      input({
        projects: [
          { id: "p1", name: "One" },
          { id: "p2", name: "Two" },
        ],
        bundles: [bundle("b1", "p1", 3), bundle("b2", "p1", 1), bundle("b3", "p2", 2)],
      }),
    );
    expect(layout.projects.map(({ id }) => id).sort()).toEqual(["p1", "p2"]);
    expect(layout.bundles.map(({ bundle: b }) => b.id).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("keeps every bundle inside its own project", () => {
    const layout = buildMapLayout(
      input({
        projects: [
          { id: "p1", name: "One" },
          { id: "p2", name: "Two" },
        ],
        bundles: [bundle("b1", "p1", 5), bundle("b3", "p2", 2)],
      }),
    );
    for (const { bundle: b, rect } of layout.bundles) {
      const parent = rectOf(layout, b.projectId);
      expect(rect.x).toBeGreaterThanOrEqual(parent.x - 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(parent.y - 1e-6);
      expect(rect.x + rect.width).toBeLessThanOrEqual(parent.x + parent.width + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(parent.y + parent.height + 1e-6);
    }
  });

  /** A project's area is the cards its bundles hold, so a busier project is a bigger box. */
  it("sizes a project by the cards its bundles hold", () => {
    const layout = buildMapLayout(
      input({
        projects: [
          { id: "big", name: "Big" },
          { id: "small", name: "Small" },
        ],
        bundles: [bundle("b1", "big", 9), bundle("b2", "small", 1)],
      }),
    );
    expect(areaOf(rectOf(layout, "big"))).toBeGreaterThan(areaOf(rectOf(layout, "small")) * 4);
  });

  it("sizes a bundle by its own cards", () => {
    const layout = buildMapLayout(input());
    expect(areaOf(rectOf(layout, "b1"))).toBeGreaterThan(areaOf(rectOf(layout, "b2")));
  });

  it("draws a project with no cards at all rather than dropping it", () => {
    const layout = buildMapLayout(
      input({
        projects: [
          { id: "p1", name: "One" },
          { id: "fresh", name: "Fresh" },
        ],
      }),
    );
    const fresh = layout.projects.find(({ id }) => id === "fresh");
    expect(fresh?.empty).toBe(true);
    expect(fresh?.rect.height).toBeGreaterThan(0);
  });

  it("leaves the whole area to the packing when there are no scopes", () => {
    const layout = buildMapLayout(input());
    expect(layout.rail.height).toBe(0);
  });

  describe("the scope graph", () => {
    const withScope = () =>
      buildMapLayout(
        input({
          projects: [
            { id: "p1", name: "One" },
            { id: "p2", name: "Two" },
          ],
          bundles: [bundle("b1", "p1", 4), bundle("b3", "p2", 4)],
          scopes: [
            {
              id: "s1",
              name: "Shared",
              spokes: [
                { kind: "bundle", id: "b1", cards: 2 },
                { kind: "bundle", id: "b3", cards: 1 },
              ],
            },
          ],
        }),
      );

    it("reserves a rail below the packing and keeps the rectangles out of it", () => {
      const layout = withScope();
      expect(layout.rail.height).toBeGreaterThan(0);
      for (const { rect } of layout.bundles) {
        expect(rect.y + rect.height).toBeLessThanOrEqual(layout.rail.y + 1e-6);
      }
    });

    it("puts the hub in the rail with a path to each bundle it reaches", () => {
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
                { kind: "bundle", id: "b1", cards: 1 },
                { kind: "bundle", id: "elsewhere", cards: 1 },
              ],
            },
          ],
        }),
      );
      expect(layout.scopes[0].spokes.map(({ id }) => id)).toEqual(["b1"]);
    });

    it("draws a taskspace-only scope against the project rectangle", () => {
      const layout = buildMapLayout(
        input({
          scopes: [{ id: "s1", name: "Files", spokes: [{ kind: "project", id: "p1", cards: 0 }] }],
        }),
      );
      expect(layout.scopes[0].spokes).toHaveLength(1);
      expect(layout.scopes[0].spokes[0].kind).toBe("project");
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

  it("draws one path per bundle the tag reaches", () => {
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

  it("says nothing about a bundle that is not on the map", () => {
    expect(tagLinks(layout, { x: 0, y: 0 }, new Map([["ghost", 1]]))).toEqual([]);
  });

  it("draws nothing for a tag reaching nowhere", () => {
    expect(tagLinks(layout, { x: 0, y: 0 }, new Map())).toEqual([]);
  });
});
