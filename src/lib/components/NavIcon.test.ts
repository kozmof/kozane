import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import NavIcon from "./NavIcon.svelte";

/**
 * The icons carry no text, so what there is to test is that each one draws the thing its
 * page is about — a set, an area, a label — and that none of them announces itself, since
 * the link around an icon is what a screen reader should read.
 */
const KINDS = ["projects", "map", "tags"] as const;

const draw = (kind: (typeof KINDS)[number]) =>
  render(NavIcon, { props: { kind } as never }).container;

const svgOf = (kind: (typeof KINDS)[number]) => draw(kind).querySelector("svg")!;

describe("NavIcon", () => {
  it("draws each destination as something of its own", () => {
    const drawn = KINDS.map((kind) => svgOf(kind).innerHTML);
    for (const markup of drawn) expect(markup.trim()).not.toBe("");
    expect(new Set(drawn).size).toBe(3);
  });

  /**
   * The meaning is the point, not just the arrangement. A tag drawn as rows of rectangles
   * says "a list", which is what the project page is — so the tag index gets the shape a tag
   * actually has, and the hole has to be a hole rather than a dot in the background colour,
   * because the header it sits in is transparent over the map.
   */
  it("draws the tag index as a tag, punched through", () => {
    const path = svgOf("tags").querySelector("path")!;
    expect(svgOf("tags").querySelector("rect")).toBeNull();
    expect(path.getAttribute("fill-rule")).toBe("evenodd");
    // Two subpaths: the label, and the hole subtracted from it.
    expect((path.getAttribute("d")!.match(/M/g) ?? []).length).toBe(2);
  });

  /** The map is a treemap, so its icon is one: rectangles of unequal size. The project list
   *  is the opposite — many of a size, no one of them the large one. */
  it("draws the map unequal and the project list even", () => {
    const areas = (kind: "projects" | "map") =>
      [...svgOf(kind).querySelectorAll("rect")].map(
        (rect) => Number(rect.getAttribute("width")) * Number(rect.getAttribute("height")),
      );
    expect(new Set(areas("projects")).size).toBe(1);
    expect(new Set(areas("map")).size).toBeGreaterThan(1);
  });

  /**
   * The icon has no colour of its own, which is what lets the link set it: at rest that is
   * `neutral.iconDim`, an icon's weight rather than a label's, and on hover it darkens the
   * whole way. A fill written into the drawing would take that away.
   */
  it("takes its colour from the link around it", () => {
    for (const kind of KINDS) {
      const svg = svgOf(kind);
      expect(svg.getAttribute("fill")).toBe("currentColor");
      for (const shape of svg.querySelectorAll("rect, path")) {
        expect(shape.getAttribute("fill")).toBeNull();
      }
    }
  });

  it("says nothing of its own, so the link around it is what is read", () => {
    for (const kind of KINDS) {
      expect(svgOf(kind).getAttribute("aria-hidden")).toBe("true");
      expect(svgOf(kind).textContent).toBe("");
    }
  });

  /** Every icon sits on the same grid, or one would look larger than the others beside it. */
  it("keeps every icon inside the same box", () => {
    for (const kind of KINDS) {
      const svg = svgOf(kind);
      expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");

      for (const rect of svg.querySelectorAll("rect")) {
        const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(rect.getAttribute(a)));
        expect(x).toBeGreaterThanOrEqual(2);
        expect(y).toBeGreaterThanOrEqual(2);
        expect(x + w).toBeLessThanOrEqual(14);
        expect(y + h).toBeLessThanOrEqual(14);
      }

      // The outline only — the hole after it is written as an arc, whose radii and flags are
      // not coordinates and would fail a test about where the ink is.
      const path = svg.querySelector("path");
      if (!path) continue;
      const outline = path.getAttribute("d")!.split(/(?=M)/)[0];
      for (const value of outline.match(/-?\d+(?:\.\d+)?/g) ?? []) {
        expect(Number(value)).toBeGreaterThanOrEqual(2);
        expect(Number(value)).toBeLessThanOrEqual(14);
      }
    }
  });
});
