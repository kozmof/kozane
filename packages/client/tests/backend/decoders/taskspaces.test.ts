import { expect, it } from "vitest";
import {
  readTaskspaceCreated,
  readTaskspaceRenamed,
  readTaskspaceRemoved,
  readTaskspaceFile,
  readTaskspaceEntryResult,
  readTaskspaceListing,
} from "../../../src/backend/decoders/taskspaces.js";
const entry = { name: "notes.md", kind: "file", size: 0, modifiedAt: null };
it("accepts empty content, nullable paths/signatures, and every directory outcome", () => {
  expect(readTaskspaceFile({ path: "notes.md", content: "", signature: null })).toEqual({
    path: "notes.md",
    content: "",
    signature: null,
  });
  expect(
    readTaskspaceRenamed({ id: "t", name: "Notes", path: null, pathKind: "absolute" }),
  ).toEqual({ id: "t", name: "Notes", path: null, pathKind: "absolute" });
  for (const directory of ["deleted", "missing", "kept"])
    expect(readTaskspaceRemoved({ ok: true, directory })).toEqual({ ok: true, directory });
});
it("preserves root paths and optional listing reasons while validating every entry", () => {
  const root = { path: "", entries: [entry], truncated: false };
  expect(readTaskspaceListing(root)).toEqual(root);
  for (const truncation of [null, "entries", "depth", "nodes", "unreadable"]) {
    expect(readTaskspaceListing({ ...root, truncated: true, truncation })).toEqual({
      ...root,
      truncated: true,
      truncation,
    });
  }
  for (const kind of ["directory", "symlink", "other"]) {
    const value = {
      ...root,
      entries: [{ ...entry, kind, size: null, modifiedAt: "2026-11-05T00:00:00Z" }],
    };
    expect(readTaskspaceListing(value)).toEqual(value);
    expect(readTaskspaceEntryResult({ path: "notes", kind })).toEqual({ path: "notes", kind });
  }
});
it("rejects missing signatures, invalid metadata and unsuccessful removal payloads", () => {
  expect(readTaskspaceCreated({ id: "t", path: "notes", pathKind: "unknown" })).toBeNull();
  expect(readTaskspaceCreated({ id: "t", pathKind: "absolute" })).toBeNull();
  expect(readTaskspaceRenamed({ id: "t", name: "Notes", pathKind: "absolute" })).toBeNull();
  expect(readTaskspaceRemoved({ ok: false, directory: "kept" })).toBeNull();
  expect(readTaskspaceRemoved({ ok: true, directory: "unknown" })).toBeNull();
  expect(readTaskspaceFile({ path: "notes", content: "" })).toBeNull();
  expect(readTaskspaceFile({ path: "notes", content: 4, signature: null })).toBeNull();
  expect(readTaskspaceEntryResult({ path: "notes", kind: "unknown" })).toBeNull();
});
it("rejects a whole listing for invalid entries, duplicates, or truncation reasons", () => {
  const root = { path: "", entries: [entry], truncated: false };
  for (const value of [
    null,
    [],
    {},
    { ...root, entries: null },
    { ...root, truncated: "false" },
    { ...root, truncation: "unknown" },
    { ...root, truncation: 1 },
    { ...root, entries: [entry, entry] },
  ])
    expect(readTaskspaceListing(value)).toBeNull();
  for (const bad of [
    { ...entry, name: "" },
    { ...entry, kind: "unknown" },
    { ...entry, size: Infinity },
    { ...entry, size: -1 },
    { ...entry, size: undefined },
    { ...entry, modifiedAt: 4 },
  ]) {
    expect(readTaskspaceListing({ ...root, entries: [entry, bad] })).toBeNull();
  }
});
