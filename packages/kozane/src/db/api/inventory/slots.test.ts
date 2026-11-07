import { describe, expect, it } from "vitest";
import { INVENTORY_SLOT_MAX } from "../../../lib/constants.js";
import { passesSlotMax } from "./slots.js";

describe("passesSlotMax", () => {
  it("accepts a plan whose cards end at or before the cap", () => {
    expect(passesSlotMax([{ cardId: "a", slot: INVENTORY_SLOT_MAX }], new Map([["a", 1]]))).toBe(
      false,
    );
  });

  it("refuses a plan whose card covers a cell past the cap", () => {
    expect(passesSlotMax([{ cardId: "a", slot: INVENTORY_SLOT_MAX }], new Map([["a", 2]]))).toBe(
      true,
    );
  });

  it("throws when a planned card has no span, rather than passing it unchecked", () => {
    expect(() => passesSlotMax([{ cardId: "a", slot: 0 }], new Map())).toThrow(
      "no span for cardId=a",
    );
  });
});
