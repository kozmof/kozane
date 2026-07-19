import { describe, expect, it } from "vitest";
import { resolveShortId, shortId } from "./short-id.js";

const first = "019f71f2-a749-7539-9342-17b86d2a0000";
const second = "019f71f2-a749-7539-9342-17b87abc0000";
const third = "019f71f2-a749-7539-9342-123456780000";

describe("shortId", () => {
  it("uses four characters from the final UUID group when unique", () => {
    expect(shortId(first, [first, third])).toBe("17b8");
  });

  it("lengthens colliding prefixes until they are unique", () => {
    expect(shortId(first, [first, second])).toBe("17b86");
    expect(shortId(second, [first, second])).toBe("17b87");
  });

  it("falls back to the full compact UUID when the final groups collide", () => {
    const collision = "019f71f2-a749-7539-9343-17b86d2a0000";
    expect(shortId(first, [first, collision])).toBe(first.replaceAll("-", ""));
  });
});

describe("resolveShortId", () => {
  it("resolves short and full IDs", () => {
    expect(resolveShortId("17b8", [first, third], "Project")).toBe(first);
    expect(resolveShortId("17b86d2a", [first, third], "Project")).toBe(first);
    expect(resolveShortId(first, [first, third], "Project")).toBe(first);
    expect(resolveShortId(first.replaceAll("-", ""), [first, third], "Project")).toBe(first);
  });

  it("resolves the first four characters of a real final UUID group", () => {
    const projectId = "019ed7a8-e997-720b-b31d-eb155d6dc15e";
    expect(resolveShortId("eb15", [projectId], "Project")).toBe(projectId);
  });

  it("rejects missing and ambiguous IDs", () => {
    expect(() => resolveShortId("ffff", [first], "Project")).toThrow("Project not found");
    expect(() => resolveShortId("17b8", [first, second], "Project")).toThrow(
      "Ambiguous project ID",
    );
  });
});
