import { describe, expect, it } from "vitest";
import {
  INVENTORY_LINE_CHARS,
  INVENTORY_SPAN_SOURCE_CHARS,
  cardSpan,
  footprintCells,
  inventoryFootprints,
  inventoryRows,
  lastCell,
  overlappingCards,
  planRefit,
  planRepair,
  planStow,
  slotCell,
} from "./inventory.js";
import { INVENTORY_SPAN_MAX } from "./constants.js";

/** A held card: id, top slot, rows covered. */
const at = (cardId: string, slot: number, span = 1) => ({ cardId, slot, span });
/** A card to place: id, rows it needs. */
const sized = (cardId: string, span = 1) => ({ cardId, span });

describe("cardSpan", () => {
  it("keeps a short card to one cell", () => {
    expect(cardSpan("")).toBe(1);
    expect(cardSpan("Buy milk")).toBe(1);
  });

  it("covers more rows as the text grows, so all of it shows", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const spans = [5, 20, 40, 80].map((n) => cardSpan(words(n)));
    expect(spans[0]).toBe(1);
    expect(spans).toEqual([...spans].sort((a, b) => a - b));
    expect(spans[3]).toBeGreaterThan(spans[1]);
  });

  it("counts line breaks as lines of their own", () => {
    expect(cardSpan("a\nb")).toBe(1);
    expect(cardSpan("a\nb\nc\nd\ne\nf")).toBeGreaterThan(1);
  });

  it("breaks a word longer than a line across lines", () => {
    const long = "x".repeat(INVENTORY_LINE_CHARS * 6);
    expect(cardSpan(long)).toBe(
      cardSpan(Array.from({ length: 6 }, () => "x".repeat(INVENTORY_LINE_CHARS)).join("\n")),
    );
  });

  it("stops at the cap, which only the text's opening can reach", () => {
    const huge = "word ".repeat(10_000);
    expect(cardSpan(huge)).toBe(INVENTORY_SPAN_MAX);
    expect(cardSpan(huge.slice(0, INVENTORY_SPAN_SOURCE_CHARS))).toBe(INVENTORY_SPAN_MAX);
  });

  it("gives the same span from the text's opening as from all of it", () => {
    // The server sizes cards from `substr`, which counts code points, and the board from the
    // whole text, so the two must never disagree. Runs of spaces, line breaks, wide
    // characters, and astral code points each change how much text a line holds.
    const opening = (text: string) => [...text].slice(0, INVENTORY_SPAN_SOURCE_CHARS).join("");
    const pieces = ["x", "word", "x".repeat(INVENTORY_LINE_CHARS), " ", "  ", "\n", "あ", "😀"];
    let seed = 1;
    const next = () => (seed = (seed * 48_271) % 2_147_483_647);
    for (let run = 0; run < 500; run++) {
      const length = 1 + (next() % 400);
      const text = Array.from({ length }, () => pieces[next() % pieces.length]).join("");
      expect(cardSpan(opening(text)), JSON.stringify(text)).toBe(cardSpan(text));
    }
    for (const separator of [" ", "  ", "   "])
      for (let width = 1; width <= INVENTORY_LINE_CHARS + 2; width++) {
        const text = Array.from({ length: 400 }, () => "x".repeat(width)).join(separator);
        expect(cardSpan(opening(text))).toBe(cardSpan(text));
      }
  });

  it("counts every space, since stored cards wrap spaces like characters", () => {
    const line = INVENTORY_LINE_CHARS;
    expect(cardSpan(`x${" ".repeat(line * 6)}y`)).toBe(
      cardSpan(Array.from({ length: 7 }, () => "x").join("\n")),
    );
  });

  it("sizes wide characters at a full em, so Japanese text is not cut short", () => {
    // 100 kana at 1em need more lines than 100 Latin letters at 0.62em.
    expect(cardSpan("あ".repeat(100))).toBeGreaterThan(cardSpan("a".repeat(100)));
    // A line breaks between wide characters, so they never break like one long word.
    expect(cardSpan("あ".repeat(8))).toBe(1);
  });
});

describe("footprintCells and lastCell", () => {
  it("run down one column", () => {
    expect(footprintCells(2, 3, 6)).toEqual([2, 8, 14]);
    expect(lastCell(2, 3, 6)).toBe(14);
  });
});

describe("planStow", () => {
  it("fills an empty inventory from the first slot, in the order given", () => {
    expect(planStow([], [sized("a"), sized("b"), sized("c")], null)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "b", slot: 1 },
      { cardId: "c", slot: 2 },
    ]);
  });

  it("fills gaps before going past the last card", () => {
    expect(planStow([at("x", 0), at("y", 2)], [sized("a"), sized("b")], null)).toEqual([
      { cardId: "a", slot: 1 },
      { cardId: "b", slot: 3 },
    ]);
  });

  it("skips cells a tall card covers, and slots a tall card would not fit", () => {
    // `x` covers slots 0, 6 and 12. A one-row card can sit beside it at 1.
    expect(planStow([at("x", 0, 3)], [sized("a")], null)).toEqual([{ cardId: "a", slot: 1 }]);
    // A two-row card cannot start at 1 when `y` holds 7 below it, so it goes to 2.
    expect(planStow([at("x", 0, 3), at("y", 7)], [sized("t", 2)], null)).toEqual([
      { cardId: "t", slot: 2 },
    ]);
  });

  it("puts one card on the empty slot it was dropped on", () => {
    expect(planStow([at("x", 0)], [sized("a", 2)], 7)).toEqual([{ cardId: "a", slot: 7 }]);
  });

  it("swaps two cards of the same inventory when each fits where the other was", () => {
    expect(planStow([at("x", 0), at("a", 4)], [sized("a")], 0)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "x", slot: 4 },
    ]);
  });

  it("moves the card in the way to the first fit when a swap would not fit", () => {
    // Swapping would put the three-row `x` at 4, over `y` at 10.
    expect(planStow([at("x", 0, 3), at("a", 4), at("y", 10)], [sized("a")], 0)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "x", slot: 1 },
    ]);
  });

  it("moves everything a tall card lands on", () => {
    expect(planStow([at("x", 0), at("y", 6)], [sized("t", 2)], 0)).toEqual([
      { cardId: "t", slot: 0 },
      { cardId: "x", slot: 1 },
      { cardId: "y", slot: 2 },
    ]);
  });

  it("moves the occupant to the first fit when the card came from elsewhere", () => {
    expect(planStow([at("x", 0), at("y", 1)], [sized("a")], 0)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "x", slot: 2 },
    ]);
  });

  it("changes nothing when a card is dropped on its own slot", () => {
    expect(planStow([at("a", 3, 2)], [sized("a", 2)], 3)).toEqual([]);
  });

  it("lets a tall card move down within its own cells", () => {
    expect(planStow([at("a", 0, 3)], [sized("a", 3)], 6)).toEqual([{ cardId: "a", slot: 6 }]);
  });

  it("leaves cards already in the inventory where they are", () => {
    expect(planStow([at("a", 2)], [sized("a"), sized("b")], null)).toEqual([
      { cardId: "b", slot: 0 },
    ]);
  });

  it("plans a repeated card once", () => {
    expect(planStow([], [sized("a"), sized("a")], null)).toEqual([{ cardId: "a", slot: 0 }]);
  });
});

describe("overlappingCards", () => {
  it("names each card whose cells another card covers, once", () => {
    // `tall` covers slots 0, 6, and 12. `low` sits on 6 and `lower` on 12.
    expect(
      overlappingCards([at("tall", 0, 3), at("low", 6), at("lower", 12), at("free", 1)]),
    ).toEqual(["tall", "low", "lower"]);
  });

  it("finds nothing in a grid a plan filled", () => {
    const plan = planStow([], [sized("a", 3), sized("b", 2), sized("c")], null);
    const spans = new Map([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
    expect(overlappingCards(plan.map((p) => at(p.cardId, p.slot, spans.get(p.cardId))))).toEqual(
      [],
    );
  });
});

describe("planRepair", () => {
  it("keeps what fits and moves the rest to the first free place after it", () => {
    // `tall` covers 0, 6, and 12, so `low` at 6 moves on to 7 and `free` at 1 stays.
    const held = [at("tall", 0, 3), at("low", 6), at("free", 1)];
    const plan = planRepair(held);
    expect(plan).toEqual([{ cardId: "low", slot: 7 }]);
    const slotOf = new Map(plan.map((p) => [p.cardId, p.slot]));
    expect(
      overlappingCards(held.map((f) => ({ ...f, slot: slotOf.get(f.cardId) ?? f.slot }))),
    ).toEqual([]);
  });

  it("moves nothing in a grid without overlaps", () => {
    expect(planRepair([at("a", 0, 2), at("b", 1), at("c", 12)])).toEqual([]);
  });
});

describe("planRefit", () => {
  it("leaves a card that still fits where it is", () => {
    expect(planRefit([at("a", 0, 2), at("b", 1)], "a")).toEqual([]);
  });

  it("moves a card whose longer text now covers a neighbour", () => {
    // `a` grew to two rows, reaching 6 where `b` is.
    expect(planRefit([at("a", 0, 2), at("b", 6)], "a")).toEqual([{ cardId: "a", slot: 1 }]);
  });

  it("does nothing for a card that is not there", () => {
    expect(planRefit([at("b", 0)], "a")).toEqual([]);
  });
});

describe("inventoryFootprints", () => {
  it("sizes one inventory's cards by their text and ignores the rest", () => {
    const cards = [
      { id: "a", content: "short", inventory: { id: "i1", slot: 2 } },
      { id: "b", content: "x", inventory: { id: "i2", slot: 0 } },
      { id: "c", content: "x", inventory: null },
    ];
    expect(inventoryFootprints(cards, "i1")).toEqual([{ cardId: "a", slot: 2, span: 1 }]);
  });
});

describe("slotCell", () => {
  it("counts left to right, then top to bottom", () => {
    expect(slotCell(0, 6)).toEqual({ row: 0, column: 0 });
    expect(slotCell(5, 6)).toEqual({ row: 0, column: 5 });
    expect(slotCell(13, 6)).toEqual({ row: 2, column: 1 });
  });
});

describe("inventoryRows", () => {
  it("draws the minimum for an empty or nearly empty inventory", () => {
    expect(inventoryRows([], 6, 3)).toBe(3);
    expect(inventoryRows([{ slot: 4, span: 1 }], 6, 3)).toBe(3);
  });

  it("keeps one empty row below the lowest cell any card covers", () => {
    expect(inventoryRows([{ slot: 17, span: 1 }], 6, 3)).toBe(4);
    // Starting in the first row but reaching down to the fourth.
    expect(inventoryRows([{ slot: 0, span: 4 }], 6, 3)).toBe(5);
  });
});
