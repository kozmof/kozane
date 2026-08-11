import { describe, it, expect } from "vitest";
import { resolveLayerRef } from "./layer-ref.js";

// Short IDs are the last 12 characters of the compacted UUID, so these two are told apart
// well before the seven characters a displayed short ID starts at.
const BASE = { id: "00000000-0000-0000-0000-1111aaaa0001", name: "Base" };
const DRAFT = { id: "00000000-0000-0000-0000-2222bbbb0002", name: "Draft" };

describe("resolveLayerRef", () => {
  it("resolves a full id", () => {
    expect(resolveLayerRef([BASE, DRAFT], DRAFT.id)).toBe(DRAFT.id);
  });

  it("resolves an unambiguous short id", () => {
    expect(resolveLayerRef([BASE, DRAFT], "2222bbb")).toBe(DRAFT.id);
  });

  it("resolves an exact name", () => {
    expect(resolveLayerRef([BASE, DRAFT], "Draft")).toBe(DRAFT.id);
  });

  it("prefers an exact name over the short id that string would also match", () => {
    const named = { ...DRAFT, name: "1111aaa" };
    expect(resolveLayerRef([BASE, named], "1111aaa")).toBe(named.id);
  });

  it("accepts a name in the wrong case", () => {
    expect(resolveLayerRef([BASE, DRAFT], "draft")).toBe(DRAFT.id);
    expect(resolveLayerRef([BASE, DRAFT], "DRAFT")).toBe(DRAFT.id);
  });

  it("still prefers the exact name when another differs only in case", () => {
    const shouty = { id: "00000000-0000-0000-0000-3333cccc0003", name: "DRAFT" };
    expect(resolveLayerRef([BASE, DRAFT, shouty], "DRAFT")).toBe(shouty.id);
    expect(resolveLayerRef([BASE, DRAFT, shouty], "Draft")).toBe(DRAFT.id);
  });

  it("refuses to guess between names that differ only in case", () => {
    const shouty = { id: "00000000-0000-0000-0000-3333cccc0003", name: "DRAFT" };
    expect(() => resolveLayerRef([BASE, DRAFT, shouty], "draft")).toThrow(
      /Ambiguous layer name: draft/,
    );
  });

  it("reports an unknown reference as a missing layer", () => {
    expect(() => resolveLayerRef([BASE, DRAFT], "nope")).toThrow(/Layer not found: nope/);
  });
});
