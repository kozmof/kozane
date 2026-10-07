import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import NavIcon from "./NavIcon.svelte";

/**
 * Verify that each icon represents its destination and stays hidden from assistive
 * technology. The enclosing link provides the accessible name.
 */
const KINDS = ["namespaces", "map", "tags"] as const;

const draw = (kind: (typeof KINDS)[number]) =>
  render(NavIcon, { props: { kind } as never }).container;

const svgOf = (kind: (typeof KINDS)[number]) => draw(kind).querySelector("svg")!;

describe("NavIcon", () => {
  it("draws each destination as something of its own", () => {
    const drawn = KINDS.map((kind) => svgOf(kind).innerHTML);
    for (const markup of drawn) expect(markup.trim()).not.toBe("");
    expect(new Set(drawn).size).toBe(3);
  });

  /** Draw connections between nested tags so the icon represents a tree. */
  describe("the tag index, as a tree", () => {
    const rects = () =>
      [...svgOf("tags").querySelectorAll("rect")].map((rect) => ({
        x: Number(rect.getAttribute("x")),
        y: Number(rect.getAttribute("y")),
        w: Number(rect.getAttribute("width")),
        h: Number(rect.getAttribute("height")),
      }));

    /** Nodes are blocks, connectors are lines. A drawing with only blocks in it is a list. */
    it("draws connections and not only nodes", () => {
      const thin = rects().filter((r) => Math.min(r.w, r.h) <= 1.5);
      const nodes = rects().filter((r) => Math.min(r.w, r.h) > 1.5);
      expect(nodes.length).toBeGreaterThan(1);
      expect(thin.length).toBeGreaterThan(1);
      // One of them runs down the icon and the others across it, or nothing is joined up.
      expect(thin.some((r) => r.h > r.w)).toBe(true);
      expect(thin.some((r) => r.w > r.h)).toBe(true);
    });

    /** A child sits in from its parent, which is the whole of what a tag namespace is. */
    it("sets the children in from the root", () => {
      const [root, ...rest] = rects();
      const children = rest.filter((r) => Math.min(r.w, r.h) > 1.5);
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) expect(child.x).toBeGreaterThan(root.x);
    });

    /** Extend the trunk through every connected branch. */
    it("runs the trunk down as far as the last branch it feeds", () => {
      const trunk = rects().find((r) => r.h > r.w && Math.min(r.w, r.h) <= 1.5)!;
      const branches = rects().filter((r) => r.w > r.h && Math.min(r.w, r.h) <= 1.5);
      const lowest = Math.max(...branches.map((b) => b.y + b.h / 2));
      expect(trunk.y + trunk.h).toBeGreaterThanOrEqual(lowest);
      // And each branch leaves the trunk rather than floating beside it.
      for (const branch of branches) expect(branch.x).toBeLessThanOrEqual(trunk.x + trunk.w);
    });
  });

  /** Use unequal areas for the map icon and equal-sized items for the namespace list. */
  it("draws the map unequal and the namespace list even", () => {
    const areas = (kind: "namespaces" | "map") =>
      [...svgOf(kind).querySelectorAll("rect")].map(
        (rect) => Number(rect.getAttribute("width")) * Number(rect.getAttribute("height")),
      );
    expect(new Set(areas("namespaces")).size).toBe(1);
    expect(new Set(areas("map")).size).toBeGreaterThan(1);
  });

  /**
   * Let the icon inherit the link's colour, including its dimmed resting state and darker
   * hover state.
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
    }
  });
});
