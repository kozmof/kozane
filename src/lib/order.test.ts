import { describe, it, expect } from "vitest";
import { compareIds } from "./order.js";

describe("compareIds", () => {
  it("orders by codepoint, the way SQLite's binary ORDER BY id does", () => {
    // Use mixed-case IDs to verify locale-independent ordering consistent with SQLite for
    // these IDs.
    expect(compareIds("B", "a")).toBeLessThan(0);
    expect(compareIds("a", "B")).toBeGreaterThan(0);
    expect("a".localeCompare("B")).toBeLessThan(0);
  });

  it("reports equal ids as equal", () => {
    expect(compareIds("card-1", "card-1")).toBe(0);
  });

  it("sorts a list the way SQLite returns it", () => {
    const ids = ["b", "A", "a", "B"];
    expect([...ids].sort(compareIds)).toEqual(["A", "B", "a", "b"]);
  });
});
