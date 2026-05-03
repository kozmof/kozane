import { describe, it, expect } from "vitest";
import { NotFoundError, assertFound } from "./utils.js";

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
