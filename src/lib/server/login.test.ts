import { describe, expect, it } from "vitest";
import { safeNext } from "./login";

describe("safeNext", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/namespace?view=all")).toBe("/namespace?view=all");
    expect(safeNext("/a/b/c")).toBe("/a/b/c");
  });

  it("rejects off-origin and malformed targets", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext("https://evil.test")).toBe("/");
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("/\\evil.test")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext("namespace")).toBe("/");
  });

  it("never loops back to the login page", () => {
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/login?next=%2F")).toBe("/");
  });
});
