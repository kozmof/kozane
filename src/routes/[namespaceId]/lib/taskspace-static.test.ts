import { describe, it, expect } from "vitest";
import { findStaticNode, staticDirectoryEntries } from "./taskspace-static.js";
import type { TaskspaceFileNode, TaskspaceFileTree } from "$lib/types";

function directory(
  name: string,
  children: TaskspaceFileNode[],
  truncated: TaskspaceFileTree["root"]["truncated"] = null,
): Extract<TaskspaceFileNode, { kind: "directory" }> {
  return { kind: "directory", name, children, truncated };
}

const file = (name: string, content = "x"): TaskspaceFileNode => ({
  kind: "file",
  name,
  content,
  size: content.length,
});

/**
 * A taskspace as `--include-scoped-files` bakes one in: two levels, one file of each kind
 * the walk can produce, and a directory the walk had to cut short.
 */
const tree: TaskspaceFileTree = {
  root: directory("", [
    file("README.md", "hello"),
    directory("src", [
      file("index.ts", "export {};"),
      { kind: "file-skipped", name: "huge.log", reason: "too-large", size: 9_000_000 },
      { kind: "symlink", name: "link" },
    ]),
    directory("vendor", [], "entries"),
  ]),
};

describe("findStaticNode", () => {
  it('answers the root itself for ""', () => {
    expect(findStaticNode(tree, "")).toBe(tree.root);
  });

  it("walks to a nested directory", () => {
    expect(findStaticNode(tree, "src")).toMatchObject({ kind: "directory", name: "src" });
  });

  it("walks to a file", () => {
    expect(findStaticNode(tree, "src/index.ts")).toMatchObject({
      kind: "file",
      content: "export {};",
    });
  });

  // The live endpoints normalize a path before resolving it; this reads what it is handed,
  // so the empty segments a leading, trailing, or doubled slash produces are dropped rather
  // than looked up as children named "".
  it("ignores empty segments from leading, trailing, and doubled slashes", () => {
    for (const path of ["/src", "src/", "//src//"]) {
      expect(findStaticNode(tree, path)).toMatchObject({ kind: "directory", name: "src" });
    }
  });

  it("answers nothing for a name no directory holds", () => {
    expect(findStaticNode(tree, "src/missing.ts")).toBeUndefined();
  });

  // A file is a leaf: descending through one is a path that names nothing, not a path to a
  // file inside it.
  it("answers nothing for a path that descends through a file", () => {
    expect(findStaticNode(tree, "README.md/inner")).toBeUndefined();
  });
});

describe("staticDirectoryEntries", () => {
  it("reports a directory's children in the shape a live listing answers with", () => {
    const src = findStaticNode(tree, "src");
    expect(src?.kind).toBe("directory");
    if (src?.kind !== "directory") return;

    expect(staticDirectoryEntries(src)).toEqual({
      truncated: null,
      entries: [
        { name: "index.ts", kind: "file", size: 10, modifiedAt: null },
        // A file the export could not carry is still a file that was there: it lists as one,
        // with the size the walk saw, so the panel draws a row rather than a gap.
        { name: "huge.log", kind: "file", size: 9_000_000, modifiedAt: null },
        // Not followed, and reported as itself.
        { name: "link", kind: "symlink", size: null, modifiedAt: null },
      ],
    });
  });

  it("carries the reason a directory is not all there", () => {
    const vendor = findStaticNode(tree, "vendor");
    if (vendor?.kind !== "directory") throw new Error("expected a directory");

    expect(staticDirectoryEntries(vendor)).toEqual({ entries: [], truncated: "entries" });
  });

  // Nothing in an export is read at a moment a viewer could be told about: the whole tree
  // was walked once at build time, so every row says null rather than the build's clock.
  it("gives every entry a null modifiedAt", () => {
    const { entries } = staticDirectoryEntries(tree.root);
    expect(entries.every(({ modifiedAt }) => modifiedAt === null)).toBe(true);
  });
});
