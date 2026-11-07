import { describe, expect, it } from "vitest";
import { mapHref } from "./map-href.js";

describe("mapHref", () => {
  it("links to the bare map when nothing narrows it", () => {
    expect(mapHref("", { namespaceId: null, tag: null, day: null })).toBe("/map");
    expect(mapHref("/base", { namespaceId: null, tag: null, day: null })).toBe("/base/map");
  });

  it("spells every narrowing in one order", () => {
    expect(mapHref("", { day: "2026-10-01", tag: "perf", namespaceId: "p1" })).toBe(
      "/map?namespaceId=p1&tag=perf&day=2026-10-01",
    );
  });

  it("encodes a tag that needs it", () => {
    expect(mapHref("", { namespaceId: null, tag: "a b:c", day: null })).toBe("/map?tag=a+b%3Ac");
  });
});
