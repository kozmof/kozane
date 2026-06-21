import { describe, it, expect } from "vitest";
import { NotFoundError, assertFound, isUniqueConstraintError, isForeignKeyError } from "./utils.js";

describe("NotFoundError", () => {
  it("has name NotFoundError", () => {
    const err = new NotFoundError("card");
    expect(err.name).toBe("NotFoundError");
  });

  it("includes the label in the message", () => {
    const err = new NotFoundError("Card cardId=abc");
    expect(err.message).toBe("Card cardId=abc not found");
  });

  it("is an instance of Error", () => {
    expect(new NotFoundError("x")).toBeInstanceOf(Error);
  });
});

describe("assertFound", () => {
  it("does not throw when array is non-empty", () => {
    expect(() => assertFound([{ id: "1" }], "card")).not.toThrow();
  });

  it("throws NotFoundError when array is empty", () => {
    expect(() => assertFound([], "card")).toThrow(NotFoundError);
  });

  it("throws with the label in the message", () => {
    expect(() => assertFound([], "Bundle bundleId=xyz")).toThrow("Bundle bundleId=xyz not found");
  });
});

describe("isUniqueConstraintError", () => {
  it("returns true for an Error with UNIQUE constraint message", () => {
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed: table.col"))).toBe(true);
  });

  it("returns false for an Error with a different message", () => {
    expect(isUniqueConstraintError(new Error("some other error"))).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isUniqueConstraintError("UNIQUE constraint failed")).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});

describe("isForeignKeyError", () => {
  it("returns true for an Error with FOREIGN KEY constraint message", () => {
    expect(isForeignKeyError(new Error("FOREIGN KEY constraint failed"))).toBe(true);
  });

  it("returns false for an Error with a different message", () => {
    expect(isForeignKeyError(new Error("some other error"))).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isForeignKeyError("FOREIGN KEY constraint failed")).toBe(false);
    expect(isForeignKeyError(42)).toBe(false);
  });
});
