import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  clearTaskspaceTagCache,
  exportTaskspaceTagCache,
  scanTaskspaceTags,
} from "./taskspace-tags.js";
import type { TagHit } from "../types.js";

const TASKSPACE_ID = "ts-1";

const scan = (dir: string, limits = {}) => scanTaskspaceTags(dir, TASKSPACE_ID, limits);
const tagsOf = (hits: TagHit[]) => hits.map(({ tag }) => tag).sort();

/**
 * Writes a file with an mtime distinct from any previous write to the same path. The cache
 * keys on mtime and size, and a test that writes twice inside one filesystem timestamp tick
 * would otherwise be exercising the documented gap rather than the cache.
 */
function write(path: string, content: string, secondsAgo = 0) {
  writeFileSync(path, content);
  if (secondsAgo) {
    const when = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, when, when);
  }
}

describe("scanTaskspaceTags", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kozane-taskspace-tags-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    clearTaskspaceTagCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds a tag in a file, with its path and line", () => {
    write(join(dir, "notes.md"), "intro\ncaching 'perf:cache here\n");

    expect(scan(dir)).toEqual({
      hits: [
        {
          tag: "perf:cache",
          source: { kind: "file", taskspaceId: TASKSPACE_ID, path: "notes.md", line: 2 },
          excerpt: "caching 'perf:cache here",
        },
      ],
      truncated: [],
      changed: true,
    });
  });

  it("finds nothing in an empty taskspace", () => {
    expect(scan(dir)).toEqual({ hits: [], truncated: [], changed: false });
  });

  it("recurses into subdirectories, and reports the path from the taskspace root", () => {
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    write(join(dir, "src", "deep", "a.txt"), "'foo");

    expect(scan(dir).hits[0].source).toEqual({
      kind: "file",
      taskspaceId: TASKSPACE_ID,
      path: "src/deep/a.txt",
      line: 1,
    });
  });

  it("gathers across several files", () => {
    write(join(dir, "a.md"), "'one");
    write(join(dir, "b.md"), "'two");

    expect(tagsOf(scan(dir).hits)).toEqual(["one", "two"]);
  });

  it("skips dot-entries, so a .git or an .env is never scanned", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    write(join(dir, ".git", "config"), "'secret");
    write(join(dir, ".env"), "'secret");

    expect(scan(dir).hits).toEqual([]);
  });

  it("does not follow a symlink out of the taskspace", () => {
    const outside = join(tmpdir(), `kozane-outside-${randomUUID()}`);
    mkdirSync(outside, { recursive: true });
    write(join(outside, "secret.md"), "'elsewhere");
    try {
      symlinkSync(outside, join(dir, "link"));
      expect(scan(dir).hits).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports a taskspace directory that is not there rather than throwing", () => {
    rmSync(dir, { recursive: true, force: true });

    expect(scan(dir)).toEqual({ hits: [], truncated: ["unreadable"], changed: false });
  });

  it("passes over a file that is not UTF-8 text", () => {
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
    write(join(dir, "notes.md"), "'foo");

    const result = scan(dir);
    expect(tagsOf(result.hits)).toEqual(["foo"]);
    expect(result.truncated).toEqual(["unreadable"]);
  });

  it("does not walk into generated or vendored directories", () => {
    for (const name of ["node_modules", "build", "dist", "coverage", "target"]) {
      mkdirSync(join(dir, name, "nested"), { recursive: true });
      write(join(dir, name, "nested", "bundle.js"), "import x from 'generated'\n");
    }
    write(join(dir, "notes.md"), "'mine");

    // Skipped, not truncated: what is left is the whole tree as this scan defines it, so a
    // taskspace with a node_modules in it must not warn on every page load.
    expect(scan(dir)).toEqual({
      hits: [
        {
          tag: "mine",
          source: { kind: "file", taskspaceId: TASKSPACE_ID, path: "notes.md", line: 1 },
          excerpt: "'mine",
        },
      ],
      truncated: [],
      changed: true,
    });
  });

  it("skips those names at any depth, not only at the root", () => {
    mkdirSync(join(dir, "packages", "app", "node_modules"), { recursive: true });
    write(join(dir, "packages", "app", "node_modules", "dep.js"), "from 'vendored'\n");
    write(join(dir, "packages", "app", "notes.md"), "'mine");

    expect(tagsOf(scan(dir).hits)).toEqual(["mine"]);
  });

  describe("limits", () => {
    it("stops at the depth limit and says so", () => {
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      write(join(dir, "a", "b", "deep.md"), "'deep");
      write(join(dir, "shallow.md"), "'shallow");

      const result = scan(dir, { depth: 1 });
      expect(tagsOf(result.hits)).toEqual(["shallow"]);
      expect(result.truncated).toEqual(["depth"]);
    });

    it("stops at the node limit and says so", () => {
      for (let i = 0; i < 5; i++) write(join(dir, `f${i}.md`), `'tag${i}`);

      const result = scan(dir, { nodes: 2 });
      expect(result.hits).toHaveLength(2);
      expect(result.truncated).toEqual(["nodes"]);
    });

    it("leaves a file past the byte budget unread, and says so", () => {
      write(join(dir, "big.md"), `'big ${"x".repeat(200)}`);

      const result = scan(dir, { bytes: 10 });
      expect(result.hits).toEqual([]);
      expect(result.truncated).toEqual(["budget"]);
    });

    /**
     * A file over the per-file cap is refused by `readTaskspaceFile` without being opened, so
     * charging the budget for it would spend bytes on something nobody ever read — and one
     * large asset beside the notes was enough to spend all of it and leave the text files
     * after it reported as `"budget"`.
     */
    it("does not spend the byte budget on a file it is going to refuse anyway", () => {
      // Over TASKSPACE_FILE_BYTES_MAX, and named so it is walked before the file below.
      writeFileSync(join(dir, "a-big.bin"), Buffer.alloc(2 * 1024 * 1024, 0x41));
      write(join(dir, "b-notes.md"), "'mine");

      const result = scan(dir, { bytes: 2 * 1024 * 1024 });
      expect(tagsOf(result.hits)).toEqual(["mine"]);
      // Named as unreadable, which it is, rather than swallowing the budget silently.
      expect(result.truncated).toEqual(["unreadable"]);
    });
  });

  describe("the cache", () => {
    it("answers the same on a second scan of an unchanged tree", () => {
      write(join(dir, "notes.md"), "'foo");

      const first = scan(dir);
      const second = scan(dir);
      expect(second.hits).toEqual(first.hits);
      expect(second.truncated).toEqual(first.truncated);
      // The one thing that must differ: the first scan read the file and the second
      // recognized it and did not, which is what tells the caller there is nothing to store.
      expect([first.changed, second.changed]).toEqual([true, false]);
    });

    it("does not spend budget re-reading an unchanged file", () => {
      write(join(dir, "a.md"), "'one");
      write(join(dir, "b.md"), "'two");
      // Enough for exactly one of the two, so what the second file costs is what this is
      // measuring: the first scan spends it all on `a.md` and cannot afford `b.md`, and the
      // second gets `a.md` free from the cache and can.
      const bytes = "'one".length;

      const first = scan(dir, { bytes });
      expect(tagsOf(first.hits)).toEqual(["one"]);
      expect(first.truncated).toEqual(["budget"]);

      const second = scan(dir, { bytes });
      expect(tagsOf(second.hits)).toEqual(["one", "two"]);
      expect(second.truncated).toEqual([]);
    });

    it("picks up a file rewritten since it was cached", () => {
      const path = join(dir, "notes.md");
      write(path, "'before", 60);
      expect(tagsOf(scan(dir).hits)).toEqual(["before"]);

      write(path, "'after");
      expect(tagsOf(scan(dir).hits)).toEqual(["after"]);
    });

    it("picks up a file added since the last scan", () => {
      write(join(dir, "a.md"), "'one");
      expect(tagsOf(scan(dir).hits)).toEqual(["one"]);

      write(join(dir, "b.md"), "'two");
      expect(tagsOf(scan(dir).hits)).toEqual(["one", "two"]);
    });

    it("forgets a file deleted since the last scan", () => {
      const path = join(dir, "notes.md");
      write(path, "'foo");
      expect(tagsOf(scan(dir).hits)).toEqual(["foo"]);

      rmSync(path);
      expect(scan(dir).hits).toEqual([]);
    });

    /**
     * The entry for a deleted file has to go, not merely stop being reported: it is handed to
     * `tag-cache.ts` and written to disk, so keeping it means a workspace's stored tags grow
     * by every file that has ever been in it.
     */
    it("forgets the stored entry for a file that is gone, not just its hits", () => {
      write(join(dir, "notes.md"), "'foo");
      scan(dir);
      expect(Object.keys(exportTaskspaceTagCache(dir) ?? {})).toEqual(["notes.md"]);

      rmSync(join(dir, "notes.md"));
      const after = scan(dir);

      expect(exportTaskspaceTagCache(dir)).toEqual({});
      // Dropping it is something learned, so the caller is told there is a new state to keep.
      expect(after.changed).toBe(true);
    });

    /** A scan that stopped early did not reach directories that are still there, so "not
     *  seen" cannot mean "no longer there" — pruning on it would discard good entries. */
    it("keeps stored entries when the walk did not finish", () => {
      write(join(dir, "a.md"), "'one");
      write(join(dir, "b.md"), "'two");
      scan(dir);

      const truncated = scan(dir, { nodes: 1 });
      expect(truncated.truncated).toEqual(["nodes"]);
      expect(Object.keys(exportTaskspaceTagCache(dir) ?? {}).sort()).toEqual(["a.md", "b.md"]);
    });

    it("keeps one taskspace's cache out of another's", () => {
      const other = join(tmpdir(), `kozane-taskspace-tags-other-${randomUUID()}`);
      mkdirSync(other, { recursive: true });
      try {
        write(join(dir, "notes.md"), "'here");
        write(join(other, "notes.md"), "'there");

        expect(tagsOf(scan(dir).hits)).toEqual(["here"]);
        expect(tagsOf(scan(other).hits)).toEqual(["there"]);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });
});
