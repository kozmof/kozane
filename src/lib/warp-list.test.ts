import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CARD_BOX,
  buildWarpDirectory,
  groupWarpEntries,
  moveHighlight,
  estimateCardHeight,
  nearestCardHint,
  cardMetrics,
  textCells,
  warpEntriesForProject,
  withoutWarp,
  WARP_HINT_MAX_CHARS,
  WARP_HINT_RADIUS,
} from "./warp-list.js";
import type { WarpListEntry } from "./warp-list.js";

function warp(id: string, posX: number, posY: number, projectId = "p1") {
  return { id, projectId, posX, posY };
}

function card(posX: number, posY: number, content: string, zIndex = 0) {
  return { posX, posY, content, zIndex };
}

// Round numbers to keep the boxes in these tests easy to follow: 30 characters to a line,
// and a one-line card 200 wide by 68 tall.
const METRICS = { cardWidth: 200, fontSize: 10 };
const hintFor = (point: { posX: number; posY: number }, cards: ReturnType<typeof card>[]) =>
  nearestCardHint(point, cards, METRICS);

describe("CARD_BOX", () => {
  // Read out of the component rather than repeated here. Panda extracts `css({...})` at
  // build time and so cannot take these from a variable, which leaves the two copies free
  // to drift apart — and a drifted copy shows up only as hints quietly naming the wrong
  // neighbouring card, which is not something anyone would think to check.
  // From the repository root, the way the Vitest config resolves its own paths: a test
  // file's own URL is not a file: one once Vite has transformed it.
  const cardSource = readFileSync(
    resolve("src/routes/[projectId]/components/KozaneCard.svelte"),
    "utf8",
  );
  // The content block is the styled element that sets a minimum height.
  const contentStyle = cardSource.split("\n").find((line) => line.includes("minHeight"));

  function styleValue(property: string): string {
    const found = contentStyle?.match(new RegExp(`${property}: "([^"]+)"`))?.[1];
    if (found === undefined) {
      throw new Error(
        `KozaneCard.svelte no longer states ${property} on the same line as minHeight, ` +
          `so CARD_BOX cannot be checked against it. Re-point this test at the card's styles.`,
      );
    }
    return found;
  }

  it("has the padding the card's content block is drawn with", () => {
    const [vertical, horizontal] = styleValue("padding")
      .split(" ")
      .map((part) => Number.parseInt(part, 10));

    expect(CARD_BOX.paddingY).toBe(vertical * 2);
    expect(CARD_BOX.paddingX).toBe(horizontal * 2);
  });

  it("has the card's line height and minimum content height", () => {
    expect(CARD_BOX.lineHeightRatio).toBe(Number(styleValue("lineHeight")));
    expect(CARD_BOX.minContentHeight).toBe(Number.parseInt(styleValue("minHeight"), 10));
  });
});

describe("estimateCardHeight", () => {
  it("gives a short card the height of the empty content block", () => {
    expect(estimateCardHeight("one line", METRICS)).toBe(44 + 24);
  });

  it("grows with the lines the text wraps to", () => {
    const wrapped = estimateCardHeight("x".repeat(90), METRICS);

    expect(wrapped).toBeGreaterThan(estimateCardHeight("x", METRICS));
    // Three lines of text, its padding, and the footer.
    expect(wrapped).toBe(3 * 10 * 1.65 + 16 + 24);
  });

  it("counts the lines the author typed as well as the ones that wrap", () => {
    expect(estimateCardHeight("a\nb\nc\nd", METRICS)).toBe(4 * 10 * 1.65 + 16 + 24);
  });

  it("gives a fullwidth character the width of two", () => {
    // 30 cells to a line, so 45 kana wrap to three lines where 45 Latin letters take two.
    expect(estimateCardHeight("あ".repeat(45), METRICS)).toBe(3 * 10 * 1.65 + 16 + 24);
    expect(estimateCardHeight("a".repeat(45), METRICS)).toBe(2 * 10 * 1.65 + 16 + 24);
  });

  it("counts an astral character once, not once per surrogate half", () => {
    // 15 emoji are 30 cells: exactly one line, not the two a UTF-16 length would give.
    expect(estimateCardHeight("🌱".repeat(15), METRICS)).toBe(44 + 24);
  });
});

describe("textCells", () => {
  it("counts a narrow character as one cell and a fullwidth one as two", () => {
    expect(textCells("abc")).toBe(3);
    expect(textCells("こざね")).toBe(6);
    expect(textCells("梅棹忠夫")).toBe(8);
    expect(textCells("ａｂｃ")).toBe(6);
    // Mixed, which is what a real card looks like.
    expect(textCells("kozane法")).toBe(8);
  });

  it("has no cells for an empty string", () => {
    expect(textCells("")).toBe(0);
  });
});

describe("cardMetrics", () => {
  it("reads the card box out of a workspace's UI settings", () => {
    expect(cardMetrics({ defaultCardWidth: 210, defaultFontSize: 11.5 })).toEqual({
      cardWidth: 210,
      fontSize: 11.5,
    });
  });
});

describe("nearestCardHint", () => {
  it("names the closest card", () => {
    const hint = hintFor(warp("w1", 100, 100), [card(400, 100, "far"), card(140, 120, "near")]);

    expect(hint).toBe("near");
  });

  it("names the card the warp sits on, not the one with the nearest corner", () => {
    // The warp is inside the first card; the second only has a corner closer to the
    // position the first card is anchored by.
    const hint = hintFor(warp("w1", 150, 30), [
      card(0, 0, "under the marker"),
      card(200, 30, "next door"),
    ]);

    expect(hint).toBe("under the marker");
  });

  it("takes the card stacked on top when the warp sits on two", () => {
    const hint = hintFor(warp("w1", 100, 30), [
      card(0, 0, "underneath", 0),
      card(20, 10, "on top", 3),
    ]);

    expect(hint).toBe("on top");
  });

  it("measures a card by the text it holds, so a tall one reaches further", () => {
    // (100, 100) is below where a one-line card ends, but well inside a card of five.
    const tall = card(0, 0, "x".repeat(150));
    const below = card(0, 120, "just below");

    expect(hintFor(warp("w1", 100, 100), [tall, below])).toBe(`${"x".repeat(47)}…`);
    // The same card with one line of text does not reach the warp, so its neighbour wins.
    expect(hintFor(warp("w1", 100, 100), [card(0, 0, "short"), below])).toBe("just below");
  });

  it("ignores cards beyond the hint radius", () => {
    const justOutside = WARP_HINT_RADIUS + 1;

    expect(hintFor(warp("w1", 0, 0), [card(justOutside, 0, "over there")])).toBeNull();
    expect(hintFor(warp("w1", 0, 0), [card(WARP_HINT_RADIUS, 0, "on the edge")])).toBe(
      "on the edge",
    );
  });

  it("has no hint when the project has no cards", () => {
    expect(hintFor(warp("w1", 0, 0), [])).toBeNull();
  });

  it("skips a card that is blank", () => {
    expect(hintFor(warp("w1", 0, 0), [card(10, 0, "   \n "), card(80, 0, "real")])).toBe("real");
  });

  it("collapses the card down to one short line", () => {
    const hint = hintFor(warp("w1", 0, 0), [card(10, 0, "  first line\n\nsecond  line ")]);

    expect(hint).toBe("first line second line");
  });

  it("truncates a long card with an ellipsis", () => {
    const hint = hintFor(warp("w1", 0, 0), [card(10, 0, "x".repeat(200))]);

    expect(hint).toHaveLength(WARP_HINT_MAX_CHARS);
    expect(hint?.endsWith("…")).toBe(true);
  });

  it("keeps the first of two equally close cards", () => {
    // 300 to the left edge of one, 300 to the right edge of the other.
    const hint = hintFor(warp("w1", 0, 0), [card(300, 0, "first"), card(-500, 0, "second")]);

    expect(hint).toBe("first");
  });
});

describe("warpEntriesForProject", () => {
  it("numbers warps from one in the order they arrive", () => {
    const entries = warpEntriesForProject({
      project: { id: "p1", name: "Kozane" },
      warps: [warp("w1", 0, 0), warp("w2", 900, 0), warp("w3", 1800, 0)],
      cards: [card(40, 0, "notes")],
      metrics: METRICS,
      isCurrent: true,
    });

    expect(entries).toMatchObject([
      { id: "w1", label: 1, projectName: "Kozane", isCurrent: true, hint: "notes" },
      { id: "w2", label: 2, hint: null },
      { id: "w3", label: 3, hint: null },
    ]);
  });
});

describe("moveHighlight", () => {
  const entries = warpEntriesForProject({
    project: { id: "p1", name: "Kozane" },
    warps: [warp("w1", 0, 0), warp("w2", 900, 0), warp("w3", 1800, 0)],
    cards: [],
    metrics: METRICS,
    isCurrent: true,
  });

  it("steps down and up the list", () => {
    expect(moveHighlight(entries, "w1", 1)?.id).toBe("w2");
    expect(moveHighlight(entries, "w2", -1)?.id).toBe("w1");
  });

  it("wraps round at both ends", () => {
    expect(moveHighlight(entries, "w3", 1)?.id).toBe("w1");
    expect(moveHighlight(entries, "w1", -1)?.id).toBe("w3");
  });

  it("starts at the end the movement comes from when nothing is highlighted", () => {
    expect(moveHighlight(entries, null, 1)?.id).toBe("w1");
    expect(moveHighlight(entries, null, -1)?.id).toBe("w3");
    expect(moveHighlight(entries, "gone", 1)?.id).toBe("w1");
  });

  it("has nothing to move to in an empty list", () => {
    expect(moveHighlight([], null, 1)).toBeNull();
  });
});

describe("withoutWarp", () => {
  const entries = [
    { id: "w1", projectId: "p1", label: 1 },
    { id: "w2", projectId: "p1", label: 2 },
    { id: "w3", projectId: "p1", label: 3 },
    { id: "w4", projectId: "p2", label: 1 },
  ] as WarpListEntry[];

  it("renumbers what is left of the project the warp belonged to", () => {
    expect(withoutWarp(entries, "w1")).toMatchObject([
      { id: "w2", label: 1 },
      { id: "w3", label: 2 },
      { id: "w4", label: 1 },
    ]);
  });

  it("leaves the other projects' numbers alone", () => {
    expect(withoutWarp(entries, "w4")).toMatchObject([
      { id: "w1", label: 1 },
      { id: "w2", label: 2 },
      { id: "w3", label: 3 },
    ]);
  });

  it("changes nothing for a warp that is not in the list", () => {
    expect(withoutWarp(entries, "gone")).toEqual(entries);
  });
});

describe("groupWarpEntries", () => {
  it("gathers consecutive entries of one project under one heading", () => {
    const entries = [
      { projectId: "p1", projectName: "Kozane", isCurrent: true, id: "w1" },
      { projectId: "p1", projectName: "Kozane", isCurrent: true, id: "w2" },
      { projectId: "p2", projectName: "Research", isCurrent: false, id: "w3" },
    ] as WarpListEntry[];

    expect(groupWarpEntries(entries)).toMatchObject([
      {
        projectId: "p1",
        projectName: "Kozane",
        isCurrent: true,
        entries: [{ id: "w1" }, { id: "w2" }],
      },
      { projectId: "p2", projectName: "Research", isCurrent: false, entries: [{ id: "w3" }] },
    ]);
  });

  it("has no groups for an empty list", () => {
    expect(groupWarpEntries([])).toEqual([]);
  });
});

describe("buildWarpDirectory", () => {
  const projects = [
    { id: "p1", name: "Kozane" },
    { id: "p2", name: "Research" },
  ];
  const warps = [warp("w1", 0, 0, "p1"), warp("w2", 100, 100, "p2"), warp("w3", 900, 900, "p2")];
  const cards = [
    { projectId: "p1", ...card(20, 0, "current project card") },
    { projectId: "p2", ...card(120, 100, "research card") },
  ];

  it("leaves out the project being viewed and numbers the rest from one", () => {
    const directory = buildWarpDirectory({
      projects,
      warps,
      cards,
      metrics: METRICS,
      excludeProjectId: "p1",
    });

    expect(directory).toMatchObject([
      {
        id: "w2",
        projectId: "p2",
        projectName: "Research",
        label: 1,
        hint: "research card",
        isCurrent: false,
      },
      { id: "w3", projectId: "p2", label: 2, hint: null },
    ]);
  });

  it("only hints with cards from the warp's own project", () => {
    const overlapping = [{ projectId: "p1", ...card(100, 100, "wrong project") }];
    const directory = buildWarpDirectory({
      projects,
      warps,
      cards: overlapping,
      metrics: METRICS,
      excludeProjectId: "p1",
    });

    expect(directory[0]).toMatchObject({ id: "w2", hint: null });
  });

  it("is empty when the workspace has only the project being viewed", () => {
    expect(
      buildWarpDirectory({
        projects: [projects[0]],
        warps,
        cards,
        metrics: METRICS,
        excludeProjectId: "p1",
      }),
    ).toEqual([]);
  });
});
