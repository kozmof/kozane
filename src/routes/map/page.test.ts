import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import MapPage from "./+page.svelte";
import { buildTagTree } from "$lib/tag";
import type { TagHit } from "$lib/types";

/**
 * The page draws rectangles it links away from and lines it draws on a selection, and both
 * are things that can look right and be wrong: a rectangle labelled with one bundle's name
 * and sized by another's count, or a tag lighting the bundles of the tag above it.
 *
 * The geometry itself is `lib/layout.test.ts` — this is about what ends up in the document.
 */

const bundle = (id: string, projectId: string, name: string, cards: number) => ({
  id,
  projectId,
  name,
  isDefault: false,
  cards,
  bg: "oklch(93% 0.055 264)",
  dot: "oklch(80% 0.21 264)",
});

const cardHit = (cardId: string, tag: string): TagHit => ({
  tag,
  source: { kind: "card", cardId },
  excerpt: `a card with '${tag}`,
});

function pageData(over: Record<string, unknown> = {}) {
  const hits = [cardHit("c1", "perf"), cardHit("c2", "perf:cache"), cardHit("c3", "docs")];
  return {
    projectId: null,
    projects: [
      { id: "p1", name: "Project One", isDefault: true },
      { id: "p2", name: "Project Two", isDefault: false },
    ],
    drawn: [
      { id: "p1", name: "Project One" },
      { id: "p2", name: "Project Two" },
    ],
    bundles: [
      bundle("b1", "p1", "General", 8),
      bundle("b2", "p1", "Drafts", 2),
      bundle("b3", "p2", "Notes", 4),
    ],
    scopes: [
      {
        id: "s1",
        name: "Release plan",
        spokes: [
          { kind: "bundle", id: "b1", cards: 3 },
          { kind: "bundle", id: "b3", cards: 1 },
        ],
      },
    ],
    tree: buildTagTree(hits),
    tag: null,
    tagBundles: { perf: { b1: 2 }, "perf:cache": { b3: 1 }, docs: { b2: 5 } },
    tagLinksTruncated: false,
    cardsTruncated: false,
    zoomStep: 0.05,
    ...over,
  };
}

const draw = (over: Record<string, unknown> = {}) =>
  render(MapPage, { props: { data: pageData(over) as never, params: {}, form: null } });

/** The lines a tag draws are the only accented paths on the page. */
const tagPaths = (container: HTMLElement) =>
  [...container.querySelectorAll("path")].filter((p) =>
    (p.getAttribute("stroke") ?? "").includes("select-accent"),
  );

const rectOf = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("g")].find((g) => g.textContent?.includes(name));

describe("map page", () => {
  it("draws a rectangle for every project and every bundle", () => {
    const { container } = draw();
    // A project's name is in the header nav and in the picture and in the words beside it,
    // so the picture is asked about specifically.
    expect(container.querySelector("svg")?.textContent).toContain("Project One");
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    // Two projects, three bundles, and none of them zero-sized.
    const rects = [...container.querySelectorAll("svg rect")];
    expect(rects).toHaveLength(5);
    for (const rect of rects) expect(Number(rect.getAttribute("width"))).toBeGreaterThan(0);
  });

  it("labels a bundle with the number of cards its area comes from", () => {
    const { container } = draw();
    expect(rectOf(container, "General")?.textContent).toContain("8");
    expect(rectOf(container, "Drafts")?.textContent).toContain("2");
  });

  it("links a bundle to the board of the project it belongs to", () => {
    const { container } = draw();
    const link = [...container.querySelectorAll("a")].find((a) =>
      a.getAttribute("aria-label")?.startsWith("Notes"),
    );
    expect(link?.getAttribute("href")).toBe("/p2");
  });

  /**
   * A project holding no cards anywhere has no area to be given and lands in the strip along
   * the bottom. It has to arrive there saying which project it is and looking like the empty
   * thing it is — drawn nameless and solid, as it once was, two of them read as a pair of
   * rectangles belonging to no project at all.
   */
  describe("a project with no cards in it", () => {
    const withEmpty = () =>
      draw({
        projects: [
          { id: "p1", name: "Project One", isDefault: true },
          { id: "p3", name: "Nothing Yet", isDefault: false },
        ],
        drawn: [
          { id: "p1", name: "Project One" },
          { id: "p3", name: "Nothing Yet" },
        ],
        bundles: [bundle("b1", "p1", "General", 8), bundle("b4", "p3", "General", 0)],
        scopes: [],
      });

    it("is drawn with its name rather than as an unlabelled box", () => {
      const { container } = withEmpty();
      expect(container.querySelector("svg")?.textContent).toContain("Nothing Yet");
    });

    it("is drawn as an outline, so it is not read as a project that packed small", () => {
      const { container } = withEmpty();
      const empty = [...container.querySelectorAll("svg > g > rect")].find(
        (rect) => rect.getAttribute("stroke-dasharray") === "2 2",
      );
      expect(empty).toBeDefined();
      expect(empty?.getAttribute("fill")).toBe("transparent");
      expect(Number(empty?.getAttribute("height"))).toBeGreaterThan(0);
    });
  });

  it("draws a hub for each scope, named, with a line per bundle it reaches", () => {
    const { container } = draw();
    expect(screen.getByText("Release plan")).toBeInTheDocument();
    expect(container.querySelectorAll("svg circle")).toHaveLength(1);
  });

  describe("the tag tree", () => {
    it("lists the tags, with the cards under each", () => {
      draw();
      const row = screen.getByText("perf").closest("a");
      expect(row?.textContent).toContain("2");
      expect(screen.getByText("2 cards")).toBeInTheDocument();
    });

    it("links a row to the same page with the tag selected", () => {
      draw();
      expect(screen.getByText("docs").closest("a")?.getAttribute("href")).toBe("/map?tag=docs");
    });

    it("links the selected row back to no selection, so a click clears it", () => {
      draw({ tag: "docs" });
      expect(screen.getByText("docs").closest("a")?.getAttribute("href")).toBe("/map");
    });

    it("keeps the project narrowing when a tag is picked", () => {
      draw({ projectId: "p1" });
      expect(screen.getByText("docs").closest("a")?.getAttribute("href")).toBe(
        "/map?projectId=p1&tag=docs",
      );
    });

    it("opens the tree down to the selected subcategory", () => {
      draw({ tag: "perf:cache" });
      expect(screen.getByText("cache")).toBeInTheDocument();
    });
  });

  describe("selecting a tag", () => {
    it("draws a line to each bundle the tag reaches", () => {
      const { container } = draw({ tag: "docs" });
      expect(tagPaths(container)).toHaveLength(1);
    });

    /** `'perf` gathers what `'perf:cache` gathers, which is the whole point of a
     *  subcategory — so selecting the parent reaches both bundles. */
    it("reaches everything under the tag, not only what carries it exactly", () => {
      const { container } = draw({ tag: "perf" });
      expect(tagPaths(container)).toHaveLength(2);
    });

    /**
     * The line leaves the panel level with its own row, and it does so in the markup rather
     * than once something has measured the page — which is what makes it right in the served
     * HTML and in a static export opened without JavaScript.
     *
     * `docs` is the first row of this tree, so its line leaves at half a row down.
     */
    it("leaves from its own row, without waiting to be measured", () => {
      const { container } = draw({ tag: "docs" });
      expect(tagPaths(container)[0].getAttribute("d")).toMatch(/^M 0 12 Q /);
    });

    it("leaves from further down for a row further down", () => {
      const { container } = draw({ tag: "perf" });
      // docs, perf, perf:cache — the second row, so a row and a half down.
      expect(tagPaths(container)[0].getAttribute("d")).toMatch(/^M 0 36 Q /);
    });

    it("draws nothing until a tag is chosen", () => {
      const { container } = draw();
      expect(tagPaths(container)).toHaveLength(0);
    });

    it("stands the rest of the map back so the lines read", () => {
      const { container } = draw({ tag: "docs" });
      const dimmed = rectOf(container, "General");
      const lit = rectOf(container, "Drafts");
      expect(Number(dimmed?.getAttribute("opacity"))).toBeLessThan(1);
      expect(Number(lit?.getAttribute("opacity"))).toBe(1);
    });

    it("dims nothing for a tag that reaches nowhere on the map", () => {
      const { container } = draw({ tag: "ghost" });
      expect(Number(rectOf(container, "General")?.getAttribute("opacity"))).toBe(1);
    });
  });

  describe("what it says when there is little to say", () => {
    it("explains an empty workspace instead of drawing an empty box", () => {
      const { container } = draw({ projects: [], drawn: [], bundles: [], scopes: [], tree: [] });
      expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
      expect(container.querySelector("svg")).toBeNull();
    });

    it("invites a first tag rather than showing an empty panel", () => {
      draw({ tree: [], tagBundles: {} });
      expect(screen.getByText(/No tags yet/)).toBeInTheDocument();
    });

    /** A tree cut at a ceiling and a workspace with that many tags look identical. */
    it("says so when the gather stopped at its ceiling", () => {
      draw({ cardsTruncated: true });
      expect(screen.getByText(/the counts above are a floor/)).toBeInTheDocument();
    });
  });

  it("says the same thing in words for a reader who cannot see it", () => {
    draw();
    const summary = screen.getByRole("heading", { name: "What the map shows" }).parentElement!;
    expect(summary.textContent).toContain("Project One: 10 cards");
    expect(summary.textContent).toContain("General: 8 cards");
    expect(summary.textContent).toContain("Release plan: reaches 2 of them");
  });
});

/**
 * Moving the map about. The arithmetic is `lib/view.test.ts`; these are about the gestures
 * reaching it — and about the one thing that can only go wrong here, which is a drag across a
 * bundle opening that bundle's board when it should have panned.
 */
describe("panning and zooming", () => {
  const surface = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[role="presentation"]')!;

  /** Every rectangle at once, as `x,y,w,h` strings — the cheapest way to say "the map
   *  moved" or "the map did not". */
  const geometry = (container: HTMLElement) =>
    [...container.querySelectorAll("svg rect")].map((r) =>
      ["x", "y", "width", "height"].map((a) => r.getAttribute(a)).join(","),
    );

  const drag = (el: HTMLElement, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  };

  it("opens fitted to the page", () => {
    draw();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("moves the whole map by the drag, without resizing anything", async () => {
    const { container } = draw();
    const before = geometry(container);
    drag(surface(container), [400, 300], [460, 260]);
    await tick();

    const after = geometry(container);
    expect(after).not.toEqual(before);
    for (const [i, box] of after.entries()) {
      const [x, y, w, h] = box.split(",").map(Number);
      const [bx, by, bw, bh] = before[i].split(",").map(Number);
      expect(x - bx).toBeCloseTo(60, 6);
      expect(y - by).toBeCloseTo(-40, 6);
      expect(w).toBeCloseTo(bw, 6);
      expect(h).toBeCloseTo(bh, 6);
    }
  });

  /**
   * The packing covers the whole box, so a drag almost always begins on a bundle — and a
   * bundle is a link. Without this, panning the map would open a board instead.
   */
  it("does not follow the link a drag began on", async () => {
    const { container } = draw();
    const link = [...container.querySelectorAll("a")].find((a) =>
      a.getAttribute("aria-label")?.startsWith("General"),
    )!;
    drag(surface(container), [400, 300], [500, 300]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("still follows a link that was clicked rather than dragged", async () => {
    const { container } = draw();
    const link = [...container.querySelectorAll("a")].find((a) =>
      a.getAttribute("aria-label")?.startsWith("General"),
    )!;
    drag(surface(container), [400, 300], [401, 300]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("enlarges the rectangles when zoomed in, and says so", async () => {
    const { container } = draw();
    const before = geometry(container);
    await fireEvent.click(screen.getByLabelText("Zoom in"));
    await tick();

    expect(screen.getByText("105%")).toBeInTheDocument();
    const widthOf = (rows: string[]) => Number(rows[0].split(",")[2]);
    expect(widthOf(geometry(container))).toBeGreaterThan(widthOf(before));
  });

  it("puts the map back when the reading is used as the way home", async () => {
    const { container } = draw();
    const fitted = geometry(container);
    drag(surface(container), [400, 300], [500, 380]);
    await fireEvent.click(screen.getByLabelText("Zoom in"));
    await tick();
    expect(geometry(container)).not.toEqual(fitted);

    await fireEvent.click(screen.getByTitle("Fit the map to the page"));
    await tick();
    expect(geometry(container)).toEqual(fitted);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("offers no way home while it is already there", () => {
    draw();
    expect(screen.getByTitle("Fitted to the page")).toBeDisabled();
  });

  /** A tag's line leaves from its row in the panel, which does not move with the map — so
   *  panning has to move the far end of the line and leave the near end alone. */
  it("keeps a tag's line attached to its row while the map moves under it", async () => {
    const { container } = draw({ tag: "docs" });
    const before = tagPaths(container)[0].getAttribute("d")!;
    drag(surface(container), [400, 300], [460, 300]);
    await tick();

    const after = tagPaths(container)[0].getAttribute("d")!;
    expect(after).not.toBe(before);
    expect(after.startsWith("M 0 12 Q ")).toBe(true);
  });
});

/**
 * What zooming a treemap is actually for. A bundle can be too small to carry its name at the
 * size the map opens at, and the way to read it is to zoom in — which only works because the
 * boxes grow and the type does not. Zoom implemented as a transform over the finished drawing
 * would enlarge the name along with the box and leave it exactly as unreadable.
 */
describe("zooming into something too small to read", () => {
  // A long tail of bundles, as a real project has. The last of them is drawn about 44px
  // wide at the size these tests render at — under the width a label needs, and over it once
  // the map has been zoomed the whole way in.
  const counts = [500, 380, 250, 120, 60, 30, 14, 7, 3, 1];
  const tiny = () =>
    draw({
      drawn: [{ id: "p1", name: "Project One" }],
      bundles: counts.map((cards, i) =>
        bundle(`b${i}`, "p1", i === counts.length - 1 ? "Scraps" : `Bundle ${i}`, cards),
      ),
      scopes: [],
      tagBundles: {},
      tree: [],
    });

  const labelled = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll("svg text")].some((t) => t.textContent === name);

  it("leaves a bundle unlabelled while its rectangle is too small for the label", () => {
    const { container } = tiny();
    expect(labelled(container, "Bundle 0")).toBe(true);
    expect(labelled(container, "Scraps")).toBe(false);
  });

  it("labels it once zoomed in far enough to hold the label", async () => {
    const { container } = tiny();
    for (let i = 0; i < 20; i++) await fireEvent.click(screen.getByLabelText("Zoom in"));
    await tick();

    expect(screen.getByText("200%")).toBeInTheDocument();
    expect(labelled(container, "Scraps")).toBe(true);
  });
});
