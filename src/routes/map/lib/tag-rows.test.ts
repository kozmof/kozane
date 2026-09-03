import { describe, it, expect } from "vitest";
import { buildTagTree } from "$lib/tag";
import type { TagHit } from "$lib/types";
import { childrenShown, tagRowCenter, visibleTagRows, TAG_ROW_HEIGHT } from "./tag-rows.js";

const hit = (cardId: string, tag: string): TagHit => ({
  tag,
  source: { kind: "card", cardId },
  excerpt: tag,
});

const tree = buildTagTree([
  hit("c1", "docs"),
  hit("c2", "perf:cache"),
  hit("c3", "perf:cache:invalidation"),
  hit("c4", "perf:disk"),
]);

const tags = (activeTag: string | null) => visibleTagRows(tree, activeTag).map(({ tag }) => tag);

describe("visibleTagRows", () => {
  it("lists the top level and its children, whatever is selected", () => {
    expect(tags(null)).toEqual(["docs", "perf", "perf:cache", "perf:disk"]);
  });

  it("opens down to the selected tag", () => {
    expect(tags("perf:cache:invalidation")).toEqual([
      "docs",
      "perf",
      "perf:cache",
      "perf:cache:invalidation",
      "perf:disk",
    ]);
  });

  it("leaves a branch the selection is not in closed", () => {
    expect(tags("perf:disk")).not.toContain("perf:cache:invalidation");
  });

  it("carries the depth each row is indented by", () => {
    const rows = visibleTagRows(tree, "perf:cache:invalidation");
    expect(rows.find((r) => r.tag === "perf:cache:invalidation")?.depth).toBe(2);
    expect(rows.find((r) => r.tag === "docs")?.depth).toBe(0);
  });
});

describe("childrenShown", () => {
  const perf = tree.find((n) => n.tag === "perf")!;
  const cache = perf.children.find((n) => n.tag === "perf:cache")!;
  const docs = tree.find((n) => n.tag === "docs")!;

  it("always opens the top level", () => {
    expect(childrenShown(perf, 0, null)).toBe(true);
  });

  it("opens a deeper node only while the active tag is inside it", () => {
    expect(childrenShown(cache, 1, null)).toBe(false);
    expect(childrenShown(cache, 1, "perf:cache:invalidation")).toBe(true);
    expect(childrenShown(cache, 1, "docs")).toBe(false);
  });

  it("says nothing to open for a leaf", () => {
    expect(childrenShown(docs, 0, "docs")).toBe(false);
  });
});

describe("tagRowCenter", () => {
  it("is the middle of the row, counted down from the top of the panel", () => {
    const rows = visibleTagRows(tree, null);
    expect(tagRowCenter(rows, "docs")).toBe(TAG_ROW_HEIGHT / 2);
    expect(tagRowCenter(rows, "perf:cache")).toBe(2 * TAG_ROW_HEIGHT + TAG_ROW_HEIGHT / 2);
  });

  it("has no answer for a tag that is not on the page", () => {
    const rows = visibleTagRows(tree, null);
    expect(tagRowCenter(rows, "perf:cache:invalidation")).toBeNull();
    expect(tagRowCenter(rows, null)).toBeNull();
  });
});
