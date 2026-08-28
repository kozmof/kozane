import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { clearTaskspaceTagCache, scanTaskspaceTags } from "./taskspace-tags.js";
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
    });
  });

  it("finds nothing in an empty taskspace", () => {
    expect(scan(dir)).toEqual({ hits: [], truncated: [] });
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

    expect(scan(dir)).toEqual({ hits: [], truncated: ["unreadable"] });
  });

  it("passes over a file that is not UTF-8 text", () => {
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
    write(join(dir, "notes.md"), "'foo");

    const result = scan(dir);
    expect(tagsOf(result.hits)).toEqual(["foo"]);
    expect(result.truncated).toEqual(["unreadable"]);
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
  });

  describe("the cache", () => {
    it("answers the same on a second scan of an unchanged tree", () => {
      write(join(dir, "notes.md"), "'foo");

      expect(scan(dir)).toEqual(scan(dir));
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
