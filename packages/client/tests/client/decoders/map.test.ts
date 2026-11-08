import { expect, it } from "vitest";
import { readMapSnapshot } from "../../../src/client/decoders/map.js";
export const emptyMap = {
  namespaces: [],
  partitions: [],
  activity: [],
  scopes: [],
  partitionUsage: [],
  namespaceUsage: [],
  tags: { hits: [], cardData: {}, cardNamespaces: {}, truncated: false },
};
it("rejects partial datasets and malformed nested tag dimensions", () => {
  expect(readMapSnapshot(emptyMap)).toEqual(emptyMap);
  expect(readMapSnapshot({ ...emptyMap, activity: null })).toBeNull();
  expect(
    readMapSnapshot({
      ...emptyMap,
      tags: { ...emptyMap.tags, cardData: { bad: { namespaceId: "ns" } } },
    }),
  ).toBeNull();
  expect(
    readMapSnapshot({
      ...emptyMap,
      partitionUsage: [{ scopeId: "scope", partitionId: "part", cards: Infinity }],
    }),
  ).toBeNull();
  expect(
    readMapSnapshot({
      ...emptyMap,
      partitions: [
        {
          id: "p",
          namespaceId: "ns",
          name: "P",
          isDefault: false,
          bg: "red",
          dot: "red",
          cards: null,
        },
      ],
    }),
  ).toBeNull();
});

it("decodes populated scope, activity and tag dimensions and rejects malformed records", () => {
  const populated = {
    namespaces: [{ id: "ns", name: "Board", isDefault: true }],
    partitions: [
      {
        id: "p",
        namespaceId: "ns",
        name: "General",
        isDefault: true,
        bg: "white",
        dot: "red",
        cards: 1,
      },
    ],
    activity: [{ day: "2026-11-05", partitionId: "p", cards: 1 }],
    scopes: [{ id: "s", name: "Scope" }],
    partitionUsage: [{ scopeId: "s", partitionId: "p", cards: 1 }],
    namespaceUsage: [{ scopeId: "s", namespaceId: "ns" }],
    tags: {
      hits: [{ tag: "topic", excerpt: ":topic", source: { kind: "card", cardId: "c" } }],
      cardData: { c: { namespaceId: "ns", partitionId: "p", updatedDay: "2026-11-05" } },
      cardNamespaces: { c: "ns" },
      truncated: false,
    },
  };
  expect(readMapSnapshot(populated)).toEqual(populated);
  for (const value of [
    null,
    [],
    { ...populated, namespaceUsage: [{ scopeId: "s", namespaceId: null }] },
    { ...populated, tags: { ...populated.tags, cardNamespaces: { c: 1 } } },
    {
      ...populated,
      tags: {
        ...populated.tags,
        hits: [{ tag: "topic", excerpt: "x", source: { kind: "file", cardId: "c" } }],
      },
    },
  ]) {
    expect(readMapSnapshot(value)).toBeNull();
  }
});
