import { describe, expect, it } from "vitest";
import { inventoryOccupants, inventoryRows, planStow, slotCell } from "./inventory.js";

const held = (...entries: [number, string][]) => new Map(entries);

describe("planStow", () => {
  it("fills an empty inventory from the first slot, in the order given", () => {
    expect(planStow(held(), ["a", "b", "c"], null)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "b", slot: 1 },
      { cardId: "c", slot: 2 },
    ]);
  });

  it("fills the gaps before going past the last card", () => {
    expect(planStow(held([0, "x"], [2, "y"]), ["a", "b"], null)).toEqual([
      { cardId: "a", slot: 1 },
      { cardId: "b", slot: 3 },
    ]);
  });

  it("puts one card on the empty slot it was dropped on", () => {
    expect(planStow(held([0, "x"]), ["a"], 7)).toEqual([{ cardId: "a", slot: 7 }]);
  });

  it("swaps two cards of the same inventory", () => {
    expect(planStow(held([0, "x"], [4, "a"]), ["a"], 0)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "x", slot: 4 },
    ]);
  });

  it("moves the occupant to the first free slot when the card came from elsewhere", () => {
    expect(planStow(held([0, "x"], [1, "y"]), ["a"], 0)).toEqual([
      { cardId: "a", slot: 0 },
      { cardId: "x", slot: 2 },
    ]);
  });

  it("changes nothing when a card is dropped on its own slot", () => {
    expect(planStow(held([3, "a"]), ["a"], 3)).toEqual([]);
  });

  it("fills from the drop slot onward when several cards arrive, skipping taken slots", () => {
    expect(planStow(held([5, "x"]), ["a", "b"], 4)).toEqual([
      { cardId: "a", slot: 4 },
      { cardId: "b", slot: 6 },
    ]);
  });

  it("leaves cards already in the inventory where they are", () => {
    expect(planStow(held([2, "a"]), ["a", "b"], null)).toEqual([{ cardId: "b", slot: 0 }]);
  });

  it("plans a repeated card once", () => {
    expect(planStow(held(), ["a", "a"], null)).toEqual([{ cardId: "a", slot: 0 }]);
  });
});

describe("inventoryOccupants", () => {
  it("keys one inventory's cards by slot and ignores the rest", () => {
    const cards = [
      { id: "a", inventoryId: "i1", inventorySlot: 2 },
      { id: "b", inventoryId: "i2", inventorySlot: 0 },
      { id: "c", inventoryId: null, inventorySlot: null },
    ];
    expect(inventoryOccupants(cards, "i1")).toEqual(new Map([[2, "a"]]));
  });
});

describe("slotCell", () => {
  it("counts left to right, then top to bottom", () => {
    expect(slotCell(0, 6)).toEqual({ row: 0, column: 0 });
    expect(slotCell(5, 6)).toEqual({ row: 0, column: 5 });
    expect(slotCell(6, 6)).toEqual({ row: 1, column: 0 });
    expect(slotCell(13, 6)).toEqual({ row: 2, column: 1 });
  });
});

describe("inventoryRows", () => {
  it("draws the minimum for an empty or nearly empty inventory", () => {
    expect(inventoryRows([], 6, 3)).toBe(3);
    expect(inventoryRows([0, 4], 6, 3)).toBe(3);
  });

  it("keeps one empty row below the last card", () => {
    // Slot 17 ends the third row, so a fourth stays open to drop into.
    expect(inventoryRows([17], 6, 3)).toBe(4);
    expect(inventoryRows([18], 6, 3)).toBe(5);
  });
});
