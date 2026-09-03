import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import NavIcon from "./NavIcon.svelte";

/**
 * The icons carry no text, so what there is to test is that the three are distinguishable
 * and that none of them announces itself — the link around an icon is what a screen reader
 * should read, and an icon that named itself as well would say everything twice.
 */
const draw = (kind: "projects" | "map" | "tags") =>
  render(NavIcon, { props: { kind } as never }).container;

const shapes = (container: HTMLElement) =>
  [...container.querySelectorAll("rect")].map((rect) =>
    ["x", "y", "width", "height"].map((a) => rect.getAttribute(a)).join(","),
  );

describe("NavIcon", () => {
  it("draws each destination as a different arrangement", () => {
    const drawn = (["projects", "map", "tags"] as const).map((kind) => shapes(draw(kind)));
    for (const rects of drawn) expect(rects.length).toBeGreaterThan(0);
    expect(new Set(drawn.map((rects) => rects.join("|"))).size).toBe(3);
  });

  /** The map is a treemap, so its icon is one: rectangles of unequal size. The project list
   *  is the opposite — many of a size, no one of them the large one. */
  it("draws the map unequal and the project list even", () => {
    const areaOf = (rect: Element) =>
      Number(rect.getAttribute("width")) * Number(rect.getAttribute("height"));
    const areas = (kind: "projects" | "map") =>
      [...draw(kind).querySelectorAll("rect")].map(areaOf);
    expect(new Set(areas("projects")).size).toBe(1);
    expect(new Set(areas("map")).size).toBeGreaterThan(1);
  });

  /**
   * The icon has no colour of its own, which is what lets the link set it: at rest that is
   * `neutral.iconDim`, an icon's weight rather than a label's, and on hover it darkens the
   * whole way. A fill written into the drawing would take that away.
   */
  it("takes its colour from the link around it", () => {
    const svg = draw("map").querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("currentColor");
    for (const rect of svg.querySelectorAll("rect")) {
      expect(rect.getAttribute("fill")).toBeNull();
    }
  });

  it("says nothing of its own, so the link around it is what is read", () => {
    const svg = draw("map").querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.textContent).toBe("");
  });

  /** Every icon sits on the same grid, or one would look larger than the others beside it. */
  it("keeps every icon inside the same box", () => {
    for (const kind of ["projects", "map", "tags"] as const) {
      const container = draw(kind);
      expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 16 16");
      for (const rect of container.querySelectorAll("rect")) {
        const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(rect.getAttribute(a)));
        expect(x).toBeGreaterThanOrEqual(2);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(x + w).toBeLessThanOrEqual(14);
        expect(y + h).toBeLessThanOrEqual(14);
      }
    }
  });
});
