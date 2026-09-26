import { describe, it, expect } from "vitest";
import { countLinked, scopeLinkState } from "./scope-link.js";

const rels = [
  { scopeId: "s1", cardId: "c1" },
  { scopeId: "s1", cardId: "c2" },
  { scopeId: "s2", cardId: "c3" },
];

describe("scopeLinkState", () => {
  it("is all when every selected card is in the scope", () => {
    expect(scopeLinkState(rels, "s1", new Set(["c1", "c2"]))).toBe("all");
    expect(scopeLinkState(rels, "s1", new Set(["c1"]))).toBe("all");
  });

  it("is some when only part of the selection is in the scope", () => {
    expect(scopeLinkState(rels, "s1", new Set(["c1", "c3"]))).toBe("some");
  });

  it("is none when nothing selected is in the scope", () => {
    expect(scopeLinkState(rels, "s1", new Set(["c3"]))).toBe("none");
    expect(scopeLinkState([], "s1", new Set(["c1"]))).toBe("none");
  });

  it("is none for an empty selection, which has nothing to be linked", () => {
    expect(scopeLinkState(rels, "s1", new Set())).toBe("none");
  });

  it("ignores relations belonging to other scopes", () => {
    expect(scopeLinkState(rels, "s2", new Set(["c1", "c2"]))).toBe("none");
  });
});

describe("countLinked", () => {
  it("counts only the selected cards in that scope", () => {
    expect(countLinked(rels, "s1", new Set(["c1", "c2", "c3"]))).toBe(2);
    expect(countLinked(rels, "s2", new Set(["c1", "c2", "c3"]))).toBe(1);
    expect(countLinked(rels, "s1", new Set())).toBe(0);
  });
});
