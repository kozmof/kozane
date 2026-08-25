import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { TASKSPACE_FILE_BYTES_MAX, TASKSPACE_SSG_DEPTH_MAX } from "../constants.js";
import { buildTaskspaceFileTree } from "./taskspace-snapshot.js";

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
    // Two files spend most of a lowered budget; the third is sized to blow past what is left
    // of it while staying far under the per-file cap, so the budget is the only limit it
    // meets — checked from the listing's reported size, before the file is ever opened.
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
    // The reader is told why a file is not there, so the reason has to be the one that
    // actually decided it: this file is withheld at any budget, and saying the export ran
    // out of room would suggest a bigger budget could have carried it.
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

  /**
   * The walk has to be as forgiving of a directory it cannot read as it already is of a
   * file: an export builds from rows written whenever the taskspace was created, against a
   * disk that has moved on. A single unreadable directory that threw from here would take
   * the whole prerender down with it — every project page, not just the subtree it could
   * not read.
   */
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
      // The rest of the taskspace is still there: one unreadable directory costs that
      // directory and nothing else.
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
   * The byte budget bounds what is read, not what is listed, and a name is free to produce
   * but still shipped in the page data — so without this the export of a taskspace pointed
   * at a checkout with a `node_modules` in it is unbounded in entries however small its
   * files are. The limit is passed here rather than reached for real: what matters is that
   * the walk stops on it and says which limit stopped it.
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

    // Three entries to spend on a tree of four: `src`, then its two files, then nothing
    // left for the sibling that sorts after it.
    const tree = buildTaskspaceFileTree(dir, { nodes: 3 });

    expect(names(tree.root.children)).toEqual(["src"]);
    expect(tree.root.truncated).toBe("nodes");
    const src = tree.root.children[0];
    expect(src).toMatchObject({ kind: "directory", truncated: null });
    if (src.kind !== "directory") throw new Error("expected a directory");
    expect(names(src.children)).toEqual(["one.ts", "two.ts"]);
  });
});
