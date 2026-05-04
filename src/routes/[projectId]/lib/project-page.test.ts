import { describe, expect, it } from "vitest";
import {
  applyPalette,
  cardsWithGlueIds,
  clampZoom,
  clientToWorld,
  dragGroupIds,
  glueGroupIds,
  glueIdByCardId,
  PALETTE,
  previousPositions,
  rectsIntersect,
  selectionRectFromPoints,
  worldRectToScreenRect,
} from "./project-page.js";
import type { Card, GlueRel } from "../../../db/api/types.js";

const cards: Card[] = [
  {
    id: "card-1",
    bundleId: "bundle-1",
    workingCopyId: null,
    content: "One",
    posX: 24,
    posY: 48,
  },
  {
    id: "card-2",
    bundleId: "bundle-1",
    workingCopyId: null,
    content: "Two",
    posX: 72,
    posY: 96,
  },
  {
    id: "card-3",
    bundleId: "bundle-2",
    workingCopyId: null,
    content: "Three",
    posX: 120,
    posY: 144,
  },
];

const glueRels: GlueRel[] = [
  { cardId: "card-1", glueId: "glue-1" },
  { cardId: "card-2", glueId: "glue-1" },
];

describe("applyPalette", () => {
  it("adds palette colors and wraps when there are more bundles than colors", () => {
    const bundles = Array.from({ length: PALETTE.length + 1 }, (_, i) => ({
      id: `bundle-${i}`,
      name: `Bundle ${i}`,
    }));

    const result = applyPalette(bundles);

    expect(result[0]).toEqual({ ...bundles[0], ...PALETTE[0] });
    expect(result[PALETTE.length]).toEqual({ ...bundles[PALETTE.length], ...PALETTE[0] });
  });
});

describe("glueIdByCardId", () => {
  it("indexes glue relationship ids by card id", () => {
    expect(
      glueIdByCardId([
        { cardId: "card-1", glueId: "glue-1" },
        { cardId: "card-2", glueId: "glue-2" },
      ]),
    ).toEqual(
      new Map([
        ["card-1", "glue-1"],
        ["card-2", "glue-2"],
      ]),
    );
  });
});

describe("cardsWithGlueIds", () => {
  it("decorates cards with glue ids and defaults unglued cards to null", () => {
    expect(cardsWithGlueIds(cards, glueRels)).toEqual([
      { ...cards[0], glueId: "glue-1" },
      { ...cards[1], glueId: "glue-1" },
      { ...cards[2], glueId: null },
    ]);
  });
});

describe("glueGroupIds", () => {
  it("returns all cards in a glue group", () => {
    expect(glueGroupIds(glueRels, "card-1")).toEqual(["card-1", "card-2"]);
  });

  it("returns the card itself when it is not glued", () => {
    expect(glueGroupIds(glueRels, "card-3")).toEqual(["card-3"]);
  });
});

describe("dragGroupIds", () => {
  it("combines glued peers with selected peers without duplicates", () => {
    expect(dragGroupIds(glueRels, new Set(["card-1", "card-2", "card-3"]), "card-1")).toEqual([
      "card-2",
      "card-3",
    ]);
  });

  it("does not drag selected cards when the active card is not selected", () => {
    expect(dragGroupIds(glueRels, new Set(["card-3"]), "card-1")).toEqual(["card-2"]);
  });
});

describe("previousPositions", () => {
  it("indexes positions for existing cards and ignores missing ids", () => {
    expect(previousPositions(cards, ["card-2", "missing"])).toEqual(
      new Map([["card-2", { x: 72, y: 96 }]]),
    );
  });
});

describe("canvas geometry", () => {
  it("converts client coordinates to world coordinates", () => {
    expect(clientToWorld(150, 220, { left: 50, top: 20 }, { x: 100, y: 40 }, 2)).toEqual({
      x: 100,
      y: 120,
    });
  });

  it("normalizes selection rectangles from any drag direction", () => {
    expect(selectionRectFromPoints({ x: 100, y: 120 }, { x: 20, y: 40 })).toEqual({
      x: 20,
      y: 40,
      w: 80,
      h: 80,
    });
  });

  it("projects world rectangles into screen space", () => {
    expect(
      worldRectToScreenRect(
        { x: 20, y: 40, w: 80, h: 100 },
        { left: 10, top: 5 },
        { x: 4, y: 8 },
        1.5,
      ),
    ).toEqual({ left: 36, top: 57, right: 156, bottom: 207 });
  });

  it("detects rectangle intersections", () => {
    expect(
      rectsIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 9, top: 9, right: 20, bottom: 20 },
      ),
    ).toBe(true);
    expect(
      rectsIntersect(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 10, top: 0, right: 20, bottom: 10 },
      ),
    ).toBe(false);
  });
});

describe("clampZoom", () => {
  it("rounds to one decimal and keeps zoom in range", () => {
    expect(clampZoom(1.04)).toBe(1);
    expect(clampZoom(1.06)).toBe(1.1);
    expect(clampZoom(0)).toBe(0.25);
    expect(clampZoom(3)).toBe(2);
  });
});
