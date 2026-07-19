import { describe, expect, it } from "vitest";
import { resolveShortId, shortId } from "./short-id.js";

const first = "019f71f2-a749-7539-9342-0f9570f6e805";
const second = "019f71f2-a749-7539-9342-1a2b70f6e805";
const third = "019f71f2-a749-7539-9342-1a2b12345678";

describe("shortId", () => {
  it("uses an eight-character UUID suffix when it is unique", () => {
    expect(shortId(first, [first, third])).toBe("70f6e805");
  });

  it("lengthens colliding suffixes until they are unique", () => {
    expect(shortId(first, [first, second])).toBe("570f6e805");
    expect(shortId(second, [first, second])).toBe("b70f6e805");
  });
});

describe("resolveShortId", () => {
  it("resolves short and full IDs", () => {
    expect(resolveShortId("70f6e805", [first, third], "Project")).toBe(first);
    expect(resolveShortId(first, [first, third], "Project")).toBe(first);
  });

  it("rejects missing and ambiguous IDs", () => {
    expect(() => resolveShortId("missing", [first], "Project")).toThrow("Project not found");
    expect(() => resolveShortId("70f6e805", [first, second], "Project")).toThrow(
      "Ambiguous project ID",
    );
  });
});
