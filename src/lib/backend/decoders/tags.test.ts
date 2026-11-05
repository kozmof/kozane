import { expect, it } from "vitest";
import { readTagsViewData } from "./tags.js";
import { tagDataset } from "../tags.fixtures.js";
it("accepts card/file gathers with warnings and optional lookup entries omitted", () => {
  const data = tagDataset([
    {
      tag: "perf",
      excerpt: "line",
      source: { kind: "file", taskspaceId: "t1", path: "notes.md", line: 3 },
    },
  ]);
  data.index.truncated = [
    { taskspaceId: "t1", reasons: ["too-large", "budget"], paths: ["notes.md"] },
  ];
  expect(readTagsViewData(JSON.parse(JSON.stringify(data)))).toEqual(data);
});
it("rejects incomplete and malformed nested datasets", () => {
  const data = tagDataset();
  const malformed = [
    null,
    {},
    { ...data, namespaces: [{}] },
    { ...data, cardPartitions: [{}] },
    { ...data, partitions: { bad: { name: "Name" } } },
    {
      ...data,
      index: {
        ...data.index,
        hits: [
          {
            tag: "perf",
            excerpt: "text",
            source: { kind: "file", taskspaceId: "t", path: "file", line: 0 },
          },
        ],
      },
    },
    { ...data, index: { ...data.index, cardData: { bad: {} } } },
    { ...data, index: { ...data.index, taskspaces: { bad: { name: "Name", namespaceId: 3 } } } },
    {
      ...data,
      index: { ...data.index, truncated: [{ taskspaceId: "t", reasons: ["unknown"], paths: [] }] },
    },
    { ...data, index: { ...data.index, missing: [3] } },
  ];
  for (const value of malformed) expect(readTagsViewData(value)).toBeNull();
});
