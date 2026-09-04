import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import MapPage from "./+page.svelte";
import { buildTagTree } from "$lib/tag";
import { DEFAULT_ZOOM, zoomPercent } from "./lib/view.js";
import { TAG_PANEL_LEFT, TAG_PANEL_TOP, TAG_PANEL_WIDTH, TAG_ROW_HEIGHT } from "./lib/tag-rows.js";
import type { TagHit } from "$lib/types";

/**
 * The page draws rectangles it links away from and lines it draws on a selection, and both
 * are things that can look right and be wrong: a rectangle labelled with one bundle's name
 * and sized by another's count, or a tag lighting the bundles of the tag above it.
 *
 * The geometry itself is `lib/map-layout.test.ts` — this is about what ends up in the document.
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

/** Where a line for the nth row of the tree starts: the panel's right edge, level with the
 *  middle of that row. Spelled out from the constants that place the panel rather than
 *  written down, so it is the same arithmetic the page does and not a copy of its answer. */
const lineStart = (row: number) =>
  `M ${TAG_PANEL_LEFT + TAG_PANEL_WIDTH} ${TAG_PANEL_TOP + row * TAG_ROW_HEIGHT + TAG_ROW_HEIGHT / 2} Q `;

const draw = (over: Record<string, unknown> = {}) =>
  render(MapPage, { props: { data: pageData(over) as never, params: {}, form: null } });

/**
 * The map's own drawing, and what is inside it.
 *
 * Scoped to the surface rather than asked of the page, because the links out of the header
 * are `<svg>` too — "the svg on the page" stopped being an answer the day they became icons,
 * and a test that had gone on asking would have been reading a 16px picture of a treemap
 * instead of the treemap.
 */
const MAP = '[role="presentation"] ';
const mapSvg = (container: HTMLElement) => container.querySelector(`${MAP}svg`);
const mapParts = (container: HTMLElement, selector: string) => [
  ...container.querySelectorAll(`${MAP}${selector}`),
];

/** The lines a tag draws are the only accented paths on the map. */
const tagPaths = (container: HTMLElement) =>
  mapParts(container, "path").filter((p) =>
    (p.getAttribute("stroke") ?? "").includes("select-accent"),
  );

const rectOf = (container: HTMLElement, name: string) =>
  mapParts(container, "g").find((g) => g.textContent?.includes(name));

describe("map page", () => {
  it("draws a rectangle for every project and every bundle", () => {
    const { container } = draw();
    // A project's name is in the header nav and in the picture and in the words beside it,
    // so the picture is asked about specifically.
    expect(mapSvg(container)?.textContent).toContain("Project One");
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    // Two projects, three bundles, and none of them zero-sized.
    const rects = mapParts(container, "svg rect");
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
      expect(mapSvg(container)?.textContent).toContain("Nothing Yet");
    });

    it("is drawn as an outline, so it is not read as a project that packed small", () => {
      const { container } = withEmpty();
      const empty = mapParts(container, "svg > g > rect").find(
        (rect) => rect.getAttribute("stroke-dasharray") === "2 2",
      );
      expect(empty).toBeDefined();
      expect(empty?.getAttribute("fill")).toBe("transparent");
      expect(Number(empty?.getAttribute("height"))).toBeGreaterThan(0);
    });
  });

  /**
   * The links out are icons now, so the anchor has to carry the name the picture no longer
   * does — and the back link is the same picture whether it leads to the whole list or to
   * one project's board.
   */
  describe("the way out", () => {
    const linkTo = (container: HTMLElement, href: string) =>
      [...container.querySelectorAll("header a")].find((a) => a.getAttribute("href") === href);

    it("names each link, since neither of them says anything in words", () => {
      const { container } = draw();
      for (const [href, name] of [
        ["/", "All projects"],
        ["/tags", "Tags"],
      ]) {
        const link = linkTo(container, href);
        expect(link?.getAttribute("aria-label")).toBe(name);
        // The picture is all there is, so an empty accessible name would leave the link
        // announcing its own URL.
        expect(link?.textContent?.trim()).toBe("");
        expect(link?.querySelector("svg")).not.toBeNull();
      }
    });

    /** The list of projects beside them stays words: it is a set of choices to read, not a
     *  way out, and three project names are not three pictures. */
    it("leaves the project narrowing in words", () => {
      const { container } = draw();
      expect(linkTo(container, "/map?projectId=p1")?.textContent?.trim()).toBe("Project One");
    });

    /**
     * Narrowed, the link no longer leads to the project list — it leads to one board — and
     * the icon is the same drawing either way. So the name is shown rather than left to the
     * label: the two destinations are not interchangeable, and nothing in the picture says
     * which one you are about to get.
     */
    it("shows the project it goes back to when the map is narrowed to one", () => {
      const { container } = draw({ projectId: "p1" });
      const back = linkTo(container, "/p1")!;
      expect(back.textContent?.trim()).toBe("Project One");
      expect(back.getAttribute("aria-label")).toBe("Back to Project One");
      // Still a picture and a name, not a name on its own.
      expect(back.querySelector("svg")).not.toBeNull();
    });

    /** Unnarrowed there is no project to name, and the icon stands alone. */
    it("shows no name when it leads to the whole list", () => {
      const { container } = draw();
      expect(linkTo(container, "/")?.textContent?.trim()).toBe("");
    });
  });

  it("draws a hub for each scope, named, with a line per bundle it reaches", () => {
    const { container } = draw();
    expect(screen.getByText("Release plan")).toBeInTheDocument();
    expect(mapParts(container, "svg circle")).toHaveLength(1);
  });

  describe("the tag tree", () => {
    it("lists the tags, with the cards under each", () => {
      draw();
      const row = screen.getByText("perf").closest("a");
      expect(row?.textContent).toContain("2");
      expect(screen.getByText("2 cards")).toBeInTheDocument();
    });

    /**
     * Written on the element rather than reached through `css()`, and asserted here because
     * losing it is silent. Panda extracts its classes by reading the source: a height
     * interpolated from a constant gets a class name and no rule, so the row keeps whatever
     * height its text came out at while every line drawn to it goes on assuming this one.
     */
    it("pins the row to the height the lines are drawn from", () => {
      const { container } = draw();
      const row = container.querySelector<HTMLElement>('nav[aria-label="Tags"] a')!;
      expect(row.getAttribute("style")).toContain(`height: ${TAG_ROW_HEIGHT}px`);
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
      expect(tagPaths(container)[0].getAttribute("d")?.startsWith(lineStart(0))).toBe(true);
    });

    it("leaves from further down for a row further down", () => {
      const { container } = draw({ tag: "perf" });
      // docs, perf, perf:cache — the second row.
      expect(tagPaths(container)[0].getAttribute("d")?.startsWith(lineStart(1))).toBe(true);
    });

    /**
     * The panel scrolls when the tree is taller than the window, which it has to now that
     * the canvas is the window and there is no page scroll left to reach the bottom of a
     * long tree with. A row that has moved is a line that has to move with it.
     */
    it("moves a line with its row when the panel is scrolled", async () => {
      const { container } = draw({ tag: "docs" });
      const panel = container.querySelector<HTMLElement>('nav[aria-label="Tags"]')!;
      const startsAt = () => tagPaths(container)[0].getAttribute("d")!.split(" Q ")[0];
      expect(startsAt()).toBe(lineStart(0).slice(0, -3));

      panel.scrollTop = 30;
      await fireEvent.scroll(panel);
      await tick();

      // The whole line is redrawn — where it lands on the bundle follows where it left from —
      // so it is the near end that is checked, and it has moved by exactly the scroll.
      const [x, y] = startsAt().split(" ").slice(1).map(Number);
      expect(x).toBe(TAG_PANEL_LEFT + TAG_PANEL_WIDTH);
      expect(y).toBe(TAG_PANEL_TOP + TAG_ROW_HEIGHT / 2 - 30);
    });

    it("draws nothing until a tag is chosen", () => {
      const { container } = draw();
      expect(tagPaths(container)).toHaveLength(0);
    });

    /**
     * A click and only a click. Hovering used to draw a tag's lines too, so a pointer
     * crossing the panel on its way somewhere else redrew the map under a reader who had
     * asked for none of it.
     */
    it("draws nothing for a tag merely pointed at", async () => {
      const { container } = draw();
      const row = [...container.querySelectorAll('nav[aria-label="Tags"] a')].find((a) =>
        a.textContent?.includes("docs"),
      )!;

      await fireEvent.mouseEnter(row);
      await fireEvent.focus(row);
      await tick();

      expect(tagPaths(container)).toHaveLength(0);
      // Nor does the packing stand back, which is the other half of a tag being drawn.
      expect(Number(rectOf(container, "General")?.getAttribute("opacity"))).toBe(1);
    });

    /** Pointing at one row while another is drawn leaves the drawn one alone. */
    it("keeps the chosen tag's lines while another row is pointed at", async () => {
      const { container } = draw({ tag: "docs" });
      const before = tagPaths(container).map((path) => path.getAttribute("d"));
      const other = [...container.querySelectorAll('nav[aria-label="Tags"] a')].find((a) =>
        a.textContent?.includes("perf"),
      )!;

      await fireEvent.mouseEnter(other);
      await tick();

      expect(tagPaths(container).map((path) => path.getAttribute("d"))).toEqual(before);
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
      expect(mapSvg(container)).toBeNull();
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
    mapParts(container, "svg rect").map((r) =>
      ["x", "y", "width", "height"].map((a) => r.getAttribute(a)).join(","),
    );

  const drag = (el: HTMLElement, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: to[0], clientY: to[1] });
  };

  /**
   * The map opens with room around it rather than fitted to the window — see `DEFAULT_ZOOM` —
   * and the control calls that 100%, because the size it opens at is the one a reader has to
   * compare against. The literal is the point of the test: a reading of anything else on a
   * map nobody has touched is a fraction of a view nobody has been shown.
   */
  it("opens reading 100%", () => {
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

    expect(screen.getByText(`${zoomPercent(DEFAULT_ZOOM + 0.05)}%`)).toBeInTheDocument();
    const widthOf = (rows: string[]) => Number(rows[0].split(",")[2]);
    expect(widthOf(geometry(container))).toBeGreaterThan(widthOf(before));
  });

  it("puts the map back when the reading is used as the way home", async () => {
    const { container } = draw();
    const opened = geometry(container);
    drag(surface(container), [400, 300], [500, 380]);
    await fireEvent.click(screen.getByLabelText("Zoom in"));
    await tick();
    expect(geometry(container)).not.toEqual(opened);

    await fireEvent.click(screen.getByTitle("Back to the size the map opens at"));
    await tick();
    expect(geometry(container)).toEqual(opened);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("offers no way home while it is already there", () => {
    draw();
    expect(screen.getByTitle("At the size the map opens at")).toBeDisabled();
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
    expect(after.startsWith(lineStart(0))).toBe(true);
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
    mapParts(container, "svg text").some((t) => t.textContent === name);

  it("leaves a bundle unlabelled while its rectangle is too small for the label", () => {
    const { container } = tiny();
    expect(labelled(container, "Bundle 0")).toBe(true);
    expect(labelled(container, "Scraps")).toBe(false);
  });

  it("labels it once zoomed in far enough to hold the label", async () => {
    const { container } = tiny();
    // Far enough to reach the ceiling from where the map opens; the clamp absorbs the rest.
    for (let i = 0; i < 40; i++) await fireEvent.click(screen.getByLabelText("Zoom in"));
    await tick();

    // The ceiling `clampZoom` allows, which is twice the window fit and so 400% of the
    // size the map opens at.
    expect(screen.getByText(`${zoomPercent(2)}%`)).toBeInTheDocument();
    expect(labelled(container, "Scraps")).toBe(true);
  });
});
