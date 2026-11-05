import { expect, it } from "vitest";
import { readMapSnapshot } from "./map.js";
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
