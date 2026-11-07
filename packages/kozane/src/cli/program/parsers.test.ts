import { expect, it } from "vitest";
import { InvalidArgumentError } from "commander";
import { integer, nonNegativeInteger, cardPosition, cardSortKey } from "./parsers.js";
import { CARD_SORT_KEYS } from "../lib/card-sort.js";

it.each(["", " ", "1.5", "NaN", "Infinity", "not-a-number"])(
  "rejects invalid integer %j",
  (value) => {
    expect(() => integer(value)).toThrow(InvalidArgumentError);
  },
);
it("accepts integer values and rejects negative counts", () => {
  expect(integer(" -12 ")).toBe(-12);
  expect(nonNegativeInteger("0")).toBe(0);
  expect(nonNegativeInteger("12")).toBe(12);
  expect(() => nonNegativeInteger("-1")).toThrow("Must be 0 or greater.");
});
it("distinguishes absolute coordinates from supported relative expressions", () => {
  expect(cardPosition("-10")).toBe(-10);
  expect(cardPosition("current+100")).toBe("current+100");
  expect(cardPosition("current-20")).toBe("current-20");
  for (const value of ["current", "current+", "current+1.5", "current +1", ""]) {
    expect(() => cardPosition(value)).toThrow(
      'Must be an integer or relative position such as "current+100".',
    );
  }
});
it("accepts the declared sort keys and rejects unknown ones", () => {
  for (const key of CARD_SORT_KEYS) expect(cardSortKey(key)).toBe(key);
  expect(() => cardSortKey("unknown")).toThrow(`Must be one of: ${CARD_SORT_KEYS.join(", ")}.`);
});
