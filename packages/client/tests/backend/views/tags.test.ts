import { expect, it } from "vitest";
import { tagsView } from "../../../src/backend/views/tags.js";
import { tagDataset } from "../tags.fixtures.js";
import { TAG_HITS_SHOWN_MAX } from "../../../src/constants/index.js";
import type { TagHit } from "../../../../kozane/src/lib/types.js";
const card = (cardId: string, tag: string): TagHit => ({
  tag,
  excerpt: "card",
  source: { kind: "card", cardId },
});
const file = (taskspaceId: string, tag: string): TagHit => ({
  tag,
  excerpt: "file",
  source: { kind: "file", taskspaceId, path: "notes.md", line: 1 },
});
it("selects normalized tags and descendants while retaining the full tree and scan warnings", () => {
  const dataset = tagDataset([
    card("one", "perf"),
    file("notes", "perf:cache"),
    card("other", "docs"),
  ]);
  dataset.index.taskspaces.missing = { name: "Unavailable", namespaceId: "p1" };
  dataset.index.missing = ["missing"];
  dataset.index.truncated = [{ taskspaceId: "notes", reasons: ["budget"], paths: ["notes.md"] }];
  dataset.index.cardsTruncated = true;
  const view = tagsView(dataset, { namespaceId: "p1", tag: "PERF" });
  expect(view.tag).toBe("perf");
  expect(view.hits).toHaveLength(2);
  expect(view.tree.map((node) => node.tag)).toContain("docs");
  expect(view.cardNamespaces).toEqual({ one: "p1" });
  expect(view.cardPartitionIds).toEqual({ one: "b1" });
  expect(view.taskspaces.missing?.name).toBe("Unavailable");
  expect(view.truncated).toEqual(dataset.index.truncated);
  expect(view.cardsTruncated).toBe(true);
});
it("caps cards and files independently and leaves static gathers complete for later filtering", () => {
  const count = TAG_HITS_SHOWN_MAX + 2;
  const dataset = tagDataset(
    Array.from({ length: count }, (_, i) => [card("c" + i, "perf"), file("t" + i, "perf")]).flat(),
  );
  const view = tagsView(dataset, { namespaceId: null, tag: "perf" });
  expect(view.hits).toHaveLength(TAG_HITS_SHOWN_MAX * 2);
  expect(view.cardTotal).toBe(count);
  expect(view.fileTotal).toBe(count);
  const exported = tagsView(dataset, { namespaceId: null, tag: null, staticExport: true });
  expect(exported.hits).toHaveLength(count * 2);
  expect(exported.cardTotal).toBeNull();
  expect(Object.keys(exported.taskspaces)).toHaveLength(count);
});
it("shows no hits without a selection and rejects deleted namespace destinations", () => {
  const dataset = tagDataset([card("one", "perf")]);
  expect(tagsView(dataset, { namespaceId: null, tag: null }).hits).toEqual([]);
  expect(() => tagsView(dataset, { namespaceId: "missing", tag: "perf" })).toThrow(
    "Namespace not found",
  );
});
it("retains opaque lookup keys without assigning object prototypes", () => {
  const view = tagsView(tagDataset([card("__proto__", "perf")]), {
    namespaceId: null,
    tag: "perf",
  });
  expect(Object.hasOwn(view.cardNamespaces, "__proto__")).toBe(true);
  expect(view.cardNamespaces.__proto__).toBe("p1");
});
