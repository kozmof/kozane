import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { TASKSPACE_FILE_BYTES_MAX, TASKSPACE_SSG_DEPTH_MAX } from "../constants.js";
import {
  buildTaskspaceFileTree,
  buildTaskspaceFileTreeOnce,
  clearTaskspaceFileTreeCache,
} from "./taskspace-snapshot.js";

function names(children: ReturnType<typeof buildTaskspaceFileTree>["root"]["children"]) {
  return children.map((child) => child.name);
}

describe("buildTaskspaceFileTree", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kozane-taskspace-snapshot-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("embeds a text file's content inline", () => {
    writeFileSync(join(dir, "README.md"), "hello\n");

    const tree = buildTaskspaceFileTree(dir);

    expect(tree.root.children).toEqual([
      { kind: "file", name: "README.md", content: "hello\n", size: 6 },
    ]);
  });

  it("recurses into subdirectories, keeping their own truncation flag", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export {}\n");

    const tree = buildTaskspaceFileTree(dir);

    expect(tree.root.children).toEqual([
      {
        kind: "directory",
        name: "src",
        truncated: null,
        children: [{ kind: "file", name: "app.ts", content: "export {}\n", size: 10 }],
      },
    ]);
  });

  it("never embeds a dot-entry, the same as the live listing hides it", () => {
    writeFileSync(join(dir, ".env"), "SECRET=shh");
    writeFileSync(join(dir, "visible.txt"), "ok\n");

    const tree = buildTaskspaceFileTree(dir);

    expect(names(tree.root.children)).toEqual(["visible.txt"]);
    expect(JSON.stringify(tree)).not.toContain("shh");
    expect(JSON.stringify(tree)).not.toContain(".env");
  });

  it("reports a symlink as itself, never following it for content", () => {
    writeFileSync(join(dir, "real.txt"), "actual\n");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));

    const tree = buildTaskspaceFileTree(dir);

    expect(tree.root.children).toContainEqual({ kind: "symlink", name: "link.txt" });
  });

  it("skips a file over the per-file size cap, but still lists its name and size", () => {
    const oversized = "x".repeat(TASKSPACE_FILE_BYTES_MAX + 1);
    writeFileSync(join(dir, "big.log"), oversized);

    const tree = buildTaskspaceFileTree(dir);

    expect(tree.root.children).toEqual([
      { kind: "file-skipped", name: "big.log", reason: "too-large", size: oversized.length },
    ]);
  });

  it("skips a file that is not valid UTF-8 text, but still lists its name", () => {
    writeFileSync(join(dir, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));

    const tree = buildTaskspaceFileTree(dir);

    expect(tree.root.children).toEqual([
      { kind: "file-skipped", name: "data.bin", reason: "not-text", size: 3 },
    ]);
  });

  it("stops embedding content once the total per-taskspace budget runs out, but keeps listing names", () => {
    // Exceed the remaining total budget with a file below the per-file limit to test the
    // budget check independently.
    const chunk = "y".repeat(400);
    writeFileSync(join(dir, "a.txt"), chunk);
    writeFileSync(join(dir, "b.txt"), chunk);
    writeFileSync(join(dir, "c.txt"), chunk);

    const tree = buildTaskspaceFileTree(dir, { bytes: 1000 });

    const byName = Object.fromEntries(tree.root.children.map((entry) => [entry.name, entry]));
    expect(byName["a.txt"]).toMatchObject({ kind: "file" });
    expect(byName["b.txt"]).toMatchObject({ kind: "file" });
    expect(byName["c.txt"]).toMatchObject({ kind: "file-skipped", reason: "budget" });
  });

  it("blames the per-file cap, not the budget, for a file that is over both", () => {
    // Report the actual exclusion reason. Increasing the budget cannot make this file
    // eligible for export.
    const oversized = "x".repeat(TASKSPACE_FILE_BYTES_MAX + 1);
    writeFileSync(join(dir, "big.log"), oversized);

    const tree = buildTaskspaceFileTree(dir, { bytes: 100 });

    expect(tree.root.children).toEqual([
      { kind: "file-skipped", name: "big.log", reason: "too-large", size: oversized.length },
    ]);
  });

  it("stops recursing past the depth guard, marking the cut-off directory truncated by depth", () => {
    let cursor = dir;
    for (let i = 0; i <= TASKSPACE_SSG_DEPTH_MAX + 2; i++) {
      cursor = join(cursor, `d${i}`);
      mkdirSync(cursor, { recursive: true });
    }
    writeFileSync(join(cursor, "deep.txt"), "unreachable\n");

    const tree = buildTaskspaceFileTree(dir);

    // Walk down until a directory is reported as cut off rather than expanded further.
    let node = tree.root;
    let guard = 0;
    while (node.children.length === 1 && node.children[0].kind === "directory" && guard < 200) {
      node = node.children[0];
      guard++;
    }
    expect(node.truncated).toBe("depth");
    expect(node.children).toEqual([]);
  });

  /** Verify that an unreadable directory is reported without failing the entire static export. */
  // Nothing is unreadable to root, so the denial this rests on does not happen there.
  it.skipIf(process.getuid?.() === 0)(
    "skips a directory it cannot read rather than failing the export",
    () => {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "app.ts"), "export {}\n");
      mkdirSync(join(dir, "locked"), { recursive: true });
      writeFileSync(join(dir, "locked", "secret.txt"), "shh\n");
      chmodSync(join(dir, "locked"), 0o000);

      let tree;
      try {
        tree = buildTaskspaceFileTree(dir);
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
      }

      const byName = Object.fromEntries(tree.root.children.map((entry) => [entry.name, entry]));
      expect(byName["locked"]).toEqual({
        kind: "directory",
        name: "locked",
        children: [],
        truncated: "unreadable",
      });
      // An unreadable directory must not prevent exporting the rest of the taskspace.
      expect(byName["src"]).toMatchObject({
        children: [{ kind: "file", name: "app.ts", content: "export {}\n", size: 10 }],
      });
    },
  );

  it("answers with an unreadable root rather than throwing when the taskspace directory is gone", () => {
    const tree = buildTaskspaceFileTree(join(dir, "was-here"));

    expect(tree.root).toEqual({
      kind: "directory",
      name: "",
      children: [],
      truncated: "unreadable",
    });
  });

  /**
   * Bound exported tree entries independently of content bytes. Verify that reaching the
   * entry limit stops the walk and reports truncation.
   */
  it("stops the walk once the tree's entry budget is spent, marking the cut-off directory", () => {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) writeFileSync(join(dir, name), "x");

    const tree = buildTaskspaceFileTree(dir, { nodes: 2 });

    expect(names(tree.root.children)).toEqual(["a.txt", "b.txt"]);
    expect(tree.root.truncated).toBe("nodes");
  });

  it("counts entries across the whole tree, not per directory", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "one.ts"), "1");
    writeFileSync(join(dir, "src", "two.ts"), "2");
    writeFileSync(join(dir, "zz.txt"), "z");

    // Spend three entries on `src` and its two files, leaving no budget for the next sibling.
    const tree = buildTaskspaceFileTree(dir, { nodes: 3 });

    expect(names(tree.root.children)).toEqual(["src"]);
    expect(tree.root.truncated).toBe("nodes");
    const src = tree.root.children[0];
    expect(src).toMatchObject({ kind: "directory", truncated: null });
    if (src.kind !== "directory") throw new Error("expected a directory");
    expect(names(src.children)).toEqual(["one.ts", "two.ts"]);
  });
});

describe("buildTaskspaceFileTreeOnce", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kozane-taskspace-memo-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    clearTaskspaceFileTreeCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearTaskspaceFileTreeCache();
  });

  it("walks a directory once and hands the same tree back for it", () => {
    writeFileSync(join(dir, "README.md"), "hello\n");

    const first = buildTaskspaceFileTreeOnce(dir);
    const second = buildTaskspaceFileTreeOnce(dir);

    // Reuse the same snapshot when multiple namespace pages request an unplaced taskspace.
    expect(second).toBe(first);
  });

  /**
   * Verify build-time tree reuse separately from fresh reads, which must observe filesystem
   * changes.
   */
  it("does not notice a write that lands after the first walk, unlike the uncached walk", () => {
    writeFileSync(join(dir, "README.md"), "hello\n");
    buildTaskspaceFileTreeOnce(dir);

    writeFileSync(join(dir, "LATER.md"), "later\n");

    expect(names(buildTaskspaceFileTreeOnce(dir).root.children)).toEqual(["README.md"]);
    expect(names(buildTaskspaceFileTree(dir).root.children)).toEqual(["LATER.md", "README.md"]);
  });

  it("keeps separate directories apart", () => {
    const other = join(tmpdir(), `kozane-taskspace-memo-test-${randomUUID()}`);
    mkdirSync(other, { recursive: true });
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      writeFileSync(join(other, "b.txt"), "b");

      expect(names(buildTaskspaceFileTreeOnce(dir).root.children)).toEqual(["a.txt"]);
      expect(names(buildTaskspaceFileTreeOnce(other).root.children)).toEqual(["b.txt"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("forgets everything once the cache is cleared", () => {
    writeFileSync(join(dir, "a.txt"), "a");
    buildTaskspaceFileTreeOnce(dir);

    clearTaskspaceFileTreeCache();
    writeFileSync(join(dir, "b.txt"), "b");

    expect(names(buildTaskspaceFileTreeOnce(dir).root.children)).toEqual(["a.txt", "b.txt"]);
  });
});
