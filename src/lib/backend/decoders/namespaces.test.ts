import { expect, it } from "vitest";
import { readNamespaceList, readNamespaceMetadata } from "./namespaces.js";
const row = { id: "opaque / namespace", name: "Board", isDefault: false };
it("returns only declared metadata and preserves opaque identifiers", () => {
  expect(readNamespaceMetadata({ ...row, privatePath: "/private/workspace" })).toEqual(row);
  expect(readNamespaceList([row])).toEqual([row]);
  expect(readNamespaceList([])).toEqual([]);
});
it.each([null, [], {}, { ...row, id: "" }, { ...row, name: 4 }, { ...row, isDefault: "false" }])(
  "rejects malformed metadata %j",
  (value) => {
    expect(readNamespaceMetadata(value)).toBeNull();
    expect(readNamespaceList([row, value])).toBeNull();
  },
);
it("rejects non-lists and duplicate identities instead of publishing ambiguous rows", () => {
  expect(readNamespaceList({ rows: [row] })).toBeNull();
  expect(readNamespaceList([row, { ...row, name: "Other" }])).toBeNull();
});
