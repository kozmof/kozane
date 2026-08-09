import { describe, expect, it } from "vitest";
import { resolveShortId, shortId, shortIdMap } from "./short-id.js";

const first = "019f71f2-a749-7539-9342-17b86d2a0000";
const second = "019f71f2-a749-7539-9342-17b87abc0000";
const third = "019f71f2-a749-7539-9342-123456780000";
// Shares first's leading seven key characters, so only an eighth separates them.
const nearTwin = "019f71f2-a749-7539-9342-17b86d2b0000";

describe("shortId", () => {
  it("uses seven characters from the final UUID group when unique", () => {
    expect(shortId(first, [first, third])).toBe("17b86d2");
  });

  it("lengthens colliding prefixes until they are unique", () => {
    expect(shortId(first, [first, nearTwin])).toBe("17b86d2a");
    expect(shortId(nearTwin, [first, nearTwin])).toBe("17b86d2b");
  });

  it("falls back to the full compact UUID when the final groups collide", () => {
    const collision = "019f71f2-a749-7539-9343-17b86d2a0000";
    expect(shortId(first, [first, collision])).toBe(first.replaceAll("-", ""));
  });
});

describe("shortIdMap", () => {
  it("agrees with shortId for every id in the set", () => {
    const collision = "019f71f2-a749-7539-9343-17b86d2a0000";
    for (const ids of [
      [first, third],
      [first, second],
      [first, nearTwin],
      [first, second, third],
      [first, collision],
      [first],
      [],
    ]) {
      const map = shortIdMap(ids);
      expect(map.size).toBe(ids.length);
      for (const id of ids) expect(map.get(id)).toBe(shortId(id, ids));
    }
  });
});

describe("resolveShortId", () => {
  it("resolves short and full IDs", () => {
    expect(resolveShortId("17b8", [first, third], "Project")).toBe(first);
    expect(resolveShortId("17b86d2a", [first, third], "Project")).toBe(first);
    expect(resolveShortId(first, [first, third], "Project")).toBe(first);
    expect(resolveShortId(first.replaceAll("-", ""), [first, third], "Project")).toBe(first);
  });

  // Resolution is independent of the displayed width, so IDs copied from older
  // output — or typed with fewer characters — keep working.
  it("accepts prefixes shorter than the displayed short ID", () => {
    const projectId = "019ed7a8-e997-720b-b31d-eb155d6dc15e";
    expect(resolveShortId("eb15", [projectId], "Project")).toBe(projectId);
    expect(resolveShortId("e", [projectId], "Project")).toBe(projectId);
  });

  it("rejects missing and ambiguous IDs", () => {
    expect(() => resolveShortId("ffff", [first], "Project")).toThrow("Project not found");
    expect(() => resolveShortId("17b8", [first, second], "Project")).toThrow(
      "Ambiguous project ID",
    );
  });
});
