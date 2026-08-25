import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  TASKSPACE_FILE_BYTES_MAX,
  TASKSPACE_SSG_DEPTH_MAX,
  TASKSPACE_SSG_TOTAL_BYTES_MAX,
} from "../constants.js";
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
        truncated: false,
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
    // Two moderate files spend part of the budget; the third is sized to blow past what is
    // left of it — checked from the listing's reported size, before any file is opened, so
    // it is skipped for running out of budget rather than for its own (unrelated) size.
    const chunk = "y".repeat(900_000);
    writeFileSync(join(dir, "a.txt"), chunk);
    writeFileSync(join(dir, "b.txt"), chunk);
    writeFileSync(join(dir, "c.txt"), "z".repeat(TASKSPACE_SSG_TOTAL_BYTES_MAX));

    const tree = buildTaskspaceFileTree(dir);

    const byName = Object.fromEntries(tree.root.children.map((entry) => [entry.name, entry]));
    expect(byName["a.txt"]).toMatchObject({ kind: "file" });
    expect(byName["b.txt"]).toMatchObject({ kind: "file" });
    expect(byName["c.txt"]).toMatchObject({ kind: "file-skipped", reason: "budget" });
  });

  it("stops recursing past the depth guard, marking the cut-off directory truncated", () => {
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
    expect(node.truncated).toBe(true);
    expect(node.children).toEqual([]);
  });
});
