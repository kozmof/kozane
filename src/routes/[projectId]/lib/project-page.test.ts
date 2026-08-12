import { describe, expect, it } from "vitest";
import {
  applyPalette,
  ARROW_DIRECTIONS,
  buildGlueGroupMap,
  cardPositionPatches,
  cardsWithGlueIds,
  centeredScrollOffset,
  clampZoom,
  clientToWorld,
  dragGroupIds,
  edgeScrollVelocity,
  glueGroupIds,
  glueIdByCardId,
  layerStack,
  moveWithin,
  nearestWarpInDirection,
  orderLayers,
  PALETTE,
  scrollForViewCenter,
  viewCenterWorld,
  warpInDirection,
  previousPositions,
  reorderByDrop,
  reorderByNudge,
  safeTriangle,
  insideTriangle,
  verticalListPosition,
  rectsIntersect,
  selectionRectFromPoints,
  worldRectToScreenRect,
} from "./project-page.js";
import type { Card, GlueRel } from "../../../db/api/types.js";

const cards: Card[] = [
  {
    id: "card-1",
    bundleId: "bundle-1",
    layerId: "layer-1",
    taskspaceId: null,
    content: "One",
    posX: 24,
    posY: 48,
    zIndex: 0,
  },
  {
    id: "card-2",
    bundleId: "bundle-1",
    layerId: "layer-1",
    taskspaceId: null,
    content: "Two",
    posX: 72,
    posY: 96,
    zIndex: 0,
  },
  {
    id: "card-3",
    bundleId: "bundle-2",
    layerId: "layer-1",
    taskspaceId: null,
    content: "Three",
    posX: 120,
    posY: 144,
    zIndex: 0,
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

describe("layerStack", () => {
  const layers = [
    { id: "base", position: 0 },
    { id: "middle", position: 1 },
    { id: "top", position: 2 },
  ];

  it("keeps index order when no layer is active", () => {
    expect(
      layerStack(layers, null).map(({ layer, rank, active }) => [layer.id, rank, active]),
    ).toEqual([
      ["base", 0, false],
      ["middle", 1, false],
      ["top", 2, false],
    ]);
  });

  it("lifts the active layer above the others, which keep their index order", () => {
    expect(layerStack(layers, "base").map(({ layer, rank }) => [layer.id, rank])).toEqual([
      ["middle", 0],
      ["top", 1],
      ["base", 2],
    ]);
  });

  it("floats the layer of a dragged card above even the active layer", () => {
    expect(layerStack(layers, "base", "middle").map(({ layer, rank }) => [layer.id, rank])).toEqual(
      [
        ["top", 0],
        ["base", 1],
        ["middle", 2],
      ],
    );
  });

  it("marks only the active layer as active", () => {
    expect(
      layerStack(layers, "top")
        .filter(({ active }) => active)
        .map(({ layer }) => layer.id),
    ).toEqual(["top"]);
  });

  it("returns an empty stack for a project without layers", () => {
    expect(layerStack([], "base")).toEqual([]);
  });

  it("marks the floating layer, so the canvas can keep it at full strength", () => {
    expect(
      layerStack(layers, "base", "middle")
        .filter(({ floating }) => floating)
        .map(({ layer }) => layer.id),
    ).toEqual(["middle"]);
  });

  it("orders by position with the id as a plain tiebreak, the way SQLite does", () => {
    const tied = [
      { id: "b", position: 0 },
      { id: "a", position: 0 },
    ];

    expect(orderLayers(tied).map(({ id }) => id)).toEqual(["a", "b"]);
  });
});

describe("moveWithin", () => {
  it("moves an id to the requested index, closing the gap behind it", () => {
    expect(moveWithin(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveWithin(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("leaves the list alone for an unknown id or an index outside it", () => {
    expect(moveWithin(["a", "b"], "z", 0)).toEqual(["a", "b"]);
    expect(moveWithin(["a", "b"], "a", 5)).toEqual(["a", "b"]);
  });
});

describe("reorderByDrop", () => {
  it("puts the dragged id where the drop target was", () => {
    expect(reorderByDrop(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("changes nothing when a row is dropped on itself", () => {
    expect(reorderByDrop(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
  });
});

describe("reorderByNudge", () => {
  it("swaps with the neighbour in the given direction", () => {
    expect(reorderByNudge(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(reorderByNudge(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("returns null at the ends of the list, where there is nothing to commit", () => {
    expect(reorderByNudge(["a", "b"], "a", -1)).toBeNull();
    expect(reorderByNudge(["a", "b"], "b", 1)).toBeNull();
  });
});

describe("safeTriangle", () => {
  // A popover hanging below its button, the way the layer control's does.
  const panel = { left: 0, top: 40, right: 180, bottom: 200 };

  it("spans from the exit point to the popover edge facing it", () => {
    expect(safeTriangle({ x: 100, y: 20 }, panel)).toEqual([
      { x: 100, y: 20 },
      { x: 0, y: 40 },
      { x: 180, y: 40 },
    ]);
  });

  it("uses the bottom edge for a popover that opens upwards", () => {
    expect(safeTriangle({ x: 100, y: 260 }, panel)).toEqual([
      { x: 100, y: 260 },
      { x: 0, y: 200 },
      { x: 180, y: 200 },
    ]);
  });

  it("uses a side edge for a popover alongside the trigger", () => {
    expect(safeTriangle({ x: -20, y: 100 }, panel)).toEqual([
      { x: -20, y: 100 },
      { x: 0, y: 40 },
      { x: 0, y: 200 },
    ]);
    expect(safeTriangle({ x: 300, y: 100 }, panel)).toEqual([
      { x: 300, y: 100 },
      { x: 180, y: 40 },
      { x: 180, y: 200 },
    ]);
  });
});

describe("insideTriangle", () => {
  const corridor = safeTriangle({ x: 100, y: 20 }, { left: 0, top: 40, right: 180, bottom: 200 });

  it("accepts a pointer heading diagonally towards the popover", () => {
    expect(insideTriangle({ x: 60, y: 35 }, corridor)).toBe(true);
  });

  it("rejects a pointer that has veered off to one side", () => {
    expect(insideTriangle({ x: 300, y: 35 }, corridor)).toBe(false);
    expect(insideTriangle({ x: 60, y: 10 }, corridor)).toBe(false);
  });

  it("counts the edges as inside, since a pointer on one is still on its way in", () => {
    expect(insideTriangle({ x: 100, y: 20 }, corridor)).toBe(true);
    expect(insideTriangle({ x: 90, y: 40 }, corridor)).toBe(true);
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
    expect(glueGroupIds(buildGlueGroupMap(glueRels), glueIdByCardId(glueRels), "card-1")).toEqual([
      "card-1",
      "card-2",
    ]);
  });

  it("returns the card itself when it is not glued", () => {
    expect(glueGroupIds(buildGlueGroupMap(glueRels), glueIdByCardId(glueRels), "card-3")).toEqual([
      "card-3",
    ]);
  });

  it("falls back to [cardId] when glueId exists in cardToGlue but not in groupMap", () => {
    const cardToGlue = new Map([["card-1", "orphan-glue-id"]]);
    const emptyGroupMap = new Map<string, string[]>();
    expect(glueGroupIds(emptyGroupMap, cardToGlue, "card-1")).toEqual(["card-1"]);
  });
});

describe("dragGroupIds", () => {
  it("combines glued peers with selected peers without duplicates", () => {
    expect(
      dragGroupIds(
        buildGlueGroupMap(glueRels),
        glueIdByCardId(glueRels),
        new Set(["card-1", "card-2", "card-3"]),
        "card-1",
      ),
    ).toEqual(["card-2", "card-3"]);
  });

  it("does not drag selected cards when the active card is not selected", () => {
    expect(
      dragGroupIds(
        buildGlueGroupMap(glueRels),
        glueIdByCardId(glueRels),
        new Set(["card-3"]),
        "card-1",
      ),
    ).toEqual(["card-2"]);
  });
});

describe("previousPositions", () => {
  it("indexes positions for existing cards and ignores missing ids", () => {
    expect(previousPositions(cards, ["card-2", "missing"])).toEqual(
      new Map([["card-2", { x: 72, y: 96 }]]),
    );
  });
});

describe("cardPositionPatches", () => {
  it("builds batch position update payloads and ignores missing ids", () => {
    expect(cardPositionPatches(cards, ["card-2", "missing", "card-1"])).toEqual([
      { cardId: "card-2", posX: 72, posY: 96 },
      { cardId: "card-1", posX: 24, posY: 48 },
    ]);
  });
});

describe("verticalListPosition", () => {
  it("places a new card below variable-height cards in the same column", () => {
    expect(
      verticalListPosition(
        [
          { posX: 96, posY: 120, width: 210, height: 60 },
          { posX: 96, posY: 216, width: 210, height: 103 },
        ],
        96,
        72,
        210,
      ),
    ).toEqual({ x: 96, y: 360 });
  });

  it("supports compact grid-aligned spacing", () => {
    expect(
      verticalListPosition([{ posX: 96, posY: 216, width: 210, height: 103 }], 96, 72, 210, 0),
    ).toEqual({ x: 96, y: 336 });
  });

  it("ignores cards outside the list column", () => {
    expect(
      verticalListPosition([{ posX: 400, posY: 500, width: 210, height: 100 }], 96, 72, 210),
    ).toEqual({ x: 96, y: 72 });
  });
});

describe("canvas geometry", () => {
  it("centers scrollable canvas content in the viewport", () => {
    expect(centeredScrollOffset(2800, 1200)).toBe(800);
    expect(centeredScrollOffset(2000, 800)).toBe(600);
    expect(centeredScrollOffset(800, 1200)).toBe(0);
  });

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
  it("rounds to two decimals and keeps zoom in range", () => {
    expect(clampZoom(1.024)).toBe(1.02);
    expect(clampZoom(1.026)).toBe(1.03);
    expect(clampZoom(0)).toBe(0.25);
    expect(clampZoom(3)).toBe(2);
  });
});

describe("edgeScrollVelocity", () => {
  it("is zero away from the edges", () => {
    expect(edgeScrollVelocity(150, 0, 300)).toBe(0);
  });

  it("accelerates toward either edge and caps beyond it", () => {
    expect(edgeScrollVelocity(40, 0, 300)).toBe(-9);
    expect(edgeScrollVelocity(260, 0, 300)).toBe(9);
    expect(edgeScrollVelocity(-20, 0, 300)).toBe(-18);
    expect(edgeScrollVelocity(320, 0, 300)).toBe(18);
  });
});

describe("viewCenterWorld", () => {
  it("is the middle of the viewport in world coordinates", () => {
    expect(viewCenterWorld(0, 800, 1)).toBe(400);
    expect(viewCenterWorld(1000, 800, 1)).toBe(1400);
    expect(viewCenterWorld(1000, 800, 2)).toBe(700);
  });
});

describe("scrollForViewCenter", () => {
  it("puts the given world point in the middle of the viewport", () => {
    expect(scrollForViewCenter(1400, 800, 1, 5000)).toBe(1000);
    expect(scrollForViewCenter(700, 800, 2, 5000)).toBe(1000);
  });

  it("clamps to the scrollable range rather than asking for an impossible offset", () => {
    expect(scrollForViewCenter(0, 800, 1, 5000)).toBe(0);
    expect(scrollForViewCenter(9000, 800, 1, 5000)).toBe(5000);
    // A canvas smaller than its viewport has nowhere to scroll.
    expect(scrollForViewCenter(9000, 800, 1, -200)).toBe(0);
  });
});

describe("nearestWarpInDirection", () => {
  const warps = [
    { id: "w1", posX: 1000, posY: 500 },
    { id: "w2", posX: 2000, posY: 500 },
    { id: "w3", posX: 500, posY: 1500 },
  ];

  it("moves to the next warp along the direction travelled", () => {
    expect(nearestWarpInDirection(warps, { x: 500, y: 500 }, "right")).toMatchObject({ id: "w1" });
    expect(nearestWarpInDirection(warps, { x: 1000, y: 500 }, "right")).toMatchObject({ id: "w2" });
    expect(nearestWarpInDirection(warps, { x: 2000, y: 500 }, "left")).toMatchObject({ id: "w1" });
    expect(nearestWarpInDirection(warps, { x: 500, y: 500 }, "down")).toMatchObject({ id: "w3" });
    expect(nearestWarpInDirection(warps, { x: 500, y: 1500 }, "up")).toMatchObject({ id: "w1" });
  });

  it("returns null when nothing lies that way", () => {
    expect(nearestWarpInDirection(warps, { x: 2000, y: 500 }, "right")).toBeNull();
    expect(nearestWarpInDirection([], { x: 0, y: 0 }, "down")).toBeNull();
  });

  it("ignores a warp the view is already centred on", () => {
    const here = [{ id: "here", posX: 100, posY: 100 }];
    expect(nearestWarpInDirection(here, { x: 100, y: 100 }, "right")).toBeNull();
    expect(nearestWarpInDirection(here, { x: 99.5, y: 100 }, "right")).toBeNull();
  });

  it("prefers a nearly straight-ahead warp over a closer but sideways one", () => {
    const candidates = [
      { id: "sideways", posX: 600, posY: 3000 },
      { id: "ahead", posX: 1400, posY: 520 },
    ];
    expect(nearestWarpInDirection(candidates, { x: 500, y: 500 }, "right")).toMatchObject({
      id: "ahead",
    });
  });

  it("breaks a tie in favour of the straighter warp", () => {
    const candidates = [
      { id: "angled", posX: 700, posY: 600 },
      { id: "straight", posX: 900, posY: 500 },
    ];
    // Both score 400: 200 + 2×100 and 400 + 2×0.
    expect(nearestWarpInDirection(candidates, { x: 500, y: 500 }, "right")).toMatchObject({
      id: "straight",
    });
  });
});

describe("warpInDirection", () => {
  const warps = [
    { id: "w1", posX: 1000, posY: 500 },
    { id: "w2", posX: 2000, posY: 500 },
    { id: "w3", posX: 500, posY: 1500 },
  ];

  it("moves to the next warp along the direction travelled", () => {
    expect(warpInDirection(warps, { x: 500, y: 500 }, "right")).toMatchObject({ id: "w1" });
    expect(warpInDirection(warps, { x: 1000, y: 500 }, "right")).toMatchObject({ id: "w2" });
  });

  it("wraps from the far side back to the near one", () => {
    // Nothing further right than w2, so → restarts at the leftmost warp.
    expect(warpInDirection(warps, { x: 2000, y: 500 }, "right")).toMatchObject({ id: "w3" });
    // And ← off w3 restarts at the rightmost.
    expect(warpInDirection(warps, { x: 500, y: 1500 }, "left")).toMatchObject({ id: "w2" });
  });

  it("wraps top to bottom and bottom to top", () => {
    expect(warpInDirection(warps, { x: 500, y: 1500 }, "down")).toMatchObject({ id: "w1" });
    expect(warpInDirection(warps, { x: 500, y: 500 }, "up")).toMatchObject({ id: "w3" });
  });

  it("keeps creation order when several warps share the edge wrapped to", () => {
    // w1 and w2 are both topmost, so wrapping downwards lands on the older one.
    expect(warpInDirection(warps, { x: 500, y: 3000 }, "down")).toMatchObject({ id: "w1" });
  });

  it("returns null only when the project has no warps", () => {
    expect(warpInDirection([], { x: 0, y: 0 }, "down")).toBeNull();
    // A lone warp is its own wrap target, so pressing an arrow re-centres on it.
    expect(warpInDirection([warps[0]], { x: 5000, y: 5000 }, "right")).toMatchObject({ id: "w1" });
  });

  it("wraps past the warp the view is already on", () => {
    const column = [
      { id: "top", posX: 500, posY: 500 },
      { id: "bottom", posX: 500, posY: 1500 },
    ];
    // Both share the leftmost x, so ← off "top" would otherwise wrap straight back to it
    // and the key would look broken.
    expect(warpInDirection(column, { x: 500, y: 500 }, "left", "top")).toMatchObject({
      id: "bottom",
    });
    // Without a current warp the wrap is unchanged: the older of the two.
    expect(warpInDirection(column, { x: 500, y: 500 }, "left")).toMatchObject({ id: "top" });
  });

  it("still lands on the only warp there is, even when the view is on it", () => {
    expect(warpInDirection([warps[0]], { x: 1000, y: 500 }, "right", "w1")).toMatchObject({
      id: "w1",
    });
  });
});

describe("ARROW_DIRECTIONS", () => {
  it("maps the four arrow keys and nothing else", () => {
    expect(ARROW_DIRECTIONS).toEqual({
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    });
    expect(ARROW_DIRECTIONS.Enter).toBeUndefined();
  });
});
