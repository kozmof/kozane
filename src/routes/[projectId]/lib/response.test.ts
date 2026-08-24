import { describe, expect, it } from "vitest";
import {
  readArray,
  readBoolean,
  readFiniteNumber,
  readNullableString,
  readString,
  readStringArray,
} from "./response.js";

describe("readString", () => {
  it("reads a string field", () => {
    expect(readString({ id: "abc" }, "id")).toBe("abc");
  });

  it("refuses an empty string, which names nothing", () => {
    expect(readString({ id: "" }, "id")).toBeUndefined();
  });

  it.each([
    ["a missing field", {}],
    ["a number", { id: 1 }],
    ["null", { id: null }],
  ])("refuses %s", (_label, body) => {
    expect(readString(body, "id")).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "id"],
    ["undefined", undefined],
  ])("refuses %s as the body", (_label, body) => {
    expect(readString(body, "id")).toBeUndefined();
  });
});

describe("readFiniteNumber", () => {
  it("reads a number field", () => {
    expect(readFiniteNumber({ posX: 12 }, "posX")).toBe(12);
  });

  it("reads zero", () => {
    expect(readFiniteNumber({ posX: 0 }, "posX")).toBe(0);
  });

  it.each([
    ["Infinity", { posX: Infinity }],
    ["NaN", { posX: NaN }],
    ["a numeric string", { posX: "12" }],
    ["null", { posX: null }],
  ])("refuses %s — it would put a card at NaN on the canvas", (_label, body) => {
    expect(readFiniteNumber(body, "posX")).toBeUndefined();
  });
});

describe("readBoolean", () => {
  it.each([
    [true, true],
    [false, false],
  ])("reads %s", (value, expected) => {
    expect(readBoolean({ isCurrent: value }, "isCurrent")).toBe(expected);
  });

  it.each([
    ["a truthy string", { isCurrent: "yes" }],
    ["a number", { isCurrent: 1 }],
    ["a missing field", {}],
  ])("refuses %s", (_label, body) => {
    expect(readBoolean(body, "isCurrent")).toBeUndefined();
  });
});

describe("readNullableString", () => {
  it("reads a string", () => {
    expect(readNullableString({ hint: "text" }, "hint")).toBe("text");
  });

  it("keeps null as a value of its own", () => {
    expect(readNullableString({ hint: null }, "hint")).toBeNull();
  });

  it("reads an empty string, unlike readString — a hint may be blank", () => {
    expect(readNullableString({ hint: "" }, "hint")).toBe("");
  });

  it("refuses anything else, so an absent field is not mistaken for a null one", () => {
    expect(readNullableString({ hint: 3 }, "hint")).toBeUndefined();
    expect(readNullableString({}, "hint")).toBeUndefined();
  });
});

describe("readStringArray", () => {
  it("reads a list of strings", () => {
    expect(readStringArray({ ids: ["a", "b"] }, "ids")).toEqual(["a", "b"]);
  });

  it("reads an empty list", () => {
    expect(readStringArray({ ids: [] }, "ids")).toEqual([]);
  });

  it("refuses the whole list when one element is not a string", () => {
    expect(readStringArray({ ids: ["a", 2] }, "ids")).toBeUndefined();
  });

  it("refuses the whole list when one element is empty", () => {
    expect(readStringArray({ ids: ["a", ""] }, "ids")).toBeUndefined();
  });

  it("refuses a non-array", () => {
    expect(readStringArray({ ids: "a" }, "ids")).toBeUndefined();
  });
});

describe("readArray", () => {
  it("reads a list without judging its elements", () => {
    expect(readArray({ stacking: [{ cardId: "a" }, 7] }, "stacking")).toEqual([{ cardId: "a" }, 7]);
  });

  it("refuses a non-array", () => {
    expect(readArray({ stacking: {} }, "stacking")).toBeUndefined();
  });

  it("refuses a missing field", () => {
    expect(readArray({}, "stacking")).toBeUndefined();
  });
});
