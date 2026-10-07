import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  clearTaskspaceTagCache,
  exportTaskspaceTagCache,
  scanTaskspaceTags,
} from "./taskspace-tags.js";
import type { TagHit } from "../types.js";
import { TASKSPACE_DIR_ENTRIES_MAX } from "../constants.js";

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
    write(join(dir, "notes.md"), "intro\ncaching :perf:cache here\n");

    expect(scan(dir)).toEqual({
      hits: [
        {
          tag: "perf:cache",
          source: { kind: "file", taskspaceId: TASKSPACE_ID, path: "notes.md", line: 2 },
          excerpt: "caching :perf:cache here",
        },
      ],
      truncated: [],
      missing: false,
      paths: [],
      changed: true,
    });
  });

  it("finds nothing in an empty taskspace", () => {
    expect(scan(dir)).toEqual({
      hits: [],
      truncated: [],
      missing: false,
      paths: [],
      changed: false,
    });
  });

  it("recurses into subdirectories, and reports the path from the taskspace root", () => {
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    write(join(dir, "src", "deep", "a.txt"), ":foo");

    expect(scan(dir).hits[0].source).toEqual({
      kind: "file",
      taskspaceId: TASKSPACE_ID,
      path: "src/deep/a.txt",
      line: 1,
    });
  });

  it("gathers across several files", () => {
    write(join(dir, "a.md"), ":one");
    write(join(dir, "b.md"), ":two");

    expect(tagsOf(scan(dir).hits)).toEqual(["one", "two"]);
  });

  it("skips dot-entries, so a .git or an .env is never scanned", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    write(join(dir, ".git", "config"), ":secret");
    write(join(dir, ".env"), ":secret");

    expect(scan(dir).hits).toEqual([]);
  });

  it("does not follow a symlink out of the taskspace", () => {
    const outside = join(tmpdir(), `kozane-outside-${randomUUID()}`);
    mkdirSync(outside, { recursive: true });
    write(join(outside, "secret.md"), ":elsewhere");
    try {
      symlinkSync(outside, join(dir, "link"));
      expect(scan(dir).hits).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /** Report an unavailable taskspace root as missing, separately from a partial scan. */
  it("reports a taskspace directory that is not there as missing rather than truncated", () => {
    rmSync(dir, { recursive: true, force: true });

    expect(scan(dir)).toEqual({
      hits: [],
      truncated: [],
      missing: true,
      paths: [],
      changed: false,
    });
  });

  /**
   * An unreadable child directory is a truncation because the taskspace root was successfully
   * read.
   */
  // Skip permission-denial tests when running as root.
  it.skipIf(process.getuid?.() === 0)(
    "reports a directory below the root that could not be listed as a truncation",
    () => {
      write(join(dir, "notes.md"), ":mine");
      mkdirSync(join(dir, "locked"));
      chmodSync(join(dir, "locked"), 0o000);

      let result;
      try {
        result = scan(dir);
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
      }

      expect(result.missing).toBe(false);
      expect(result.truncated).toEqual(["unreadable"]);
      expect(result.paths).toEqual(["locked/"]);
      expect(tagsOf(result.hits)).toEqual(["mine"]);
    },
  );

  it("passes over a file that is not UTF-8 text", () => {
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
    write(join(dir, "notes.md"), ":foo");

    const result = scan(dir);
    expect(tagsOf(result.hits)).toEqual(["foo"]);
    expect(result.truncated).toEqual(["unreadable"]);
  });

  it("does not walk into generated or vendored directories", () => {
    for (const name of ["node_modules", "build", "dist", "coverage", "target"]) {
      mkdirSync(join(dir, name, "nested"), { recursive: true });
      write(join(dir, name, "nested", "partition.js"), "import x from 'generated'\n");
    }
    write(join(dir, "notes.md"), ":mine");

    // Skipped directories are outside the scan's scope and must not cause truncation
    // warnings.
    expect(scan(dir)).toEqual({
      hits: [
        {
          tag: "mine",
          source: { kind: "file", taskspaceId: TASKSPACE_ID, path: "notes.md", line: 1 },
          excerpt: ":mine",
        },
      ],
      truncated: [],
      missing: false,
      paths: [],
      changed: true,
    });
  });

  it("skips those names at any depth, not only at the root", () => {
    mkdirSync(join(dir, "packages", "app", "node_modules"), { recursive: true });
    write(join(dir, "packages", "app", "node_modules", "dep.js"), "from 'vendored'\n");
    write(join(dir, "packages", "app", "notes.md"), ":mine");

    expect(tagsOf(scan(dir).hits)).toEqual(["mine"]);
  });

  describe("limits", () => {
    it("stops at the depth limit and says so", () => {
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      write(join(dir, "a", "b", "deep.md"), ":deep");
      write(join(dir, "shallow.md"), ":shallow");

      const result = scan(dir, { depth: 1 });
      expect(tagsOf(result.hits)).toEqual(["shallow"]);
      expect(result.truncated).toEqual(["depth"]);
    });

    it("stops at the node limit and says so", () => {
      for (let i = 0; i < 5; i++) write(join(dir, `f${i}.md`), `:tag${i}`);

      const result = scan(dir, { nodes: 2 });
      expect(result.hits).toHaveLength(2);
      expect(result.truncated).toEqual(["nodes"]);
    });

    it("leaves a file past the byte budget unread, and says so", () => {
      write(join(dir, "big.md"), `:big ${"x".repeat(200)}`);

      const result = scan(dir, { bytes: 10 });
      expect(result.hits).toEqual([]);
      expect(result.truncated).toEqual(["budget"]);
    });

    /** Do not charge the byte budget for an oversized file rejected before reading. */
    it("does not spend the byte budget on a file it is going to refuse anyway", () => {
      // Over TASKSPACE_FILE_BYTES_MAX, and named so it is walked before the file below.
      writeFileSync(join(dir, "a-big.bin"), Buffer.alloc(2 * 1024 * 1024, 0x41));
      write(join(dir, "b-notes.md"), ":mine");

      const result = scan(dir, { bytes: 2 * 1024 * 1024 });
      expect(tagsOf(result.hits)).toEqual(["mine"]);
      // Report oversized files separately from read failures.
      expect(result.truncated).toEqual(["too-large"]);
    });

    it("tells a file too large to open apart from one that could not be read", () => {
      writeFileSync(join(dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 0x41));
      writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));

      expect(scan(dir).truncated.sort()).toEqual(["too-large", "unreadable"]);
    });

    /**
     * Bound tag hits independently of bytes and entries because a small file can contain many
     * tags.
     */
    it("stops at the hit ceiling and says so", () => {
      write(join(dir, "many.md"), Array.from({ length: 20 }, (_, i) => `:t${i}`).join("\n"));

      const result = scan(dir, { hits: 5 });
      expect(result.hits).toHaveLength(5);
      expect(result.truncated).toEqual(["hits"]);
    });

    /** Exact rather than per-file. One generated file can hold more tags on its own than the
     *  whole scan carries, so checking only between files would let it through in full. */
    it("holds the ceiling exactly, within a single file", () => {
      write(join(dir, "one.md"), Array.from({ length: 500 }, (_, i) => `:t${i}`).join("\n"));

      expect(scan(dir, { hits: 3 }).hits).toHaveLength(3);
    });

    /** Once full there is nowhere for the rest of the tree to be read into, so the walk stops
     *  rather than spending bytes and syscalls on hits that would only be dropped. */
    it("stops walking once it is full", () => {
      write(join(dir, "a.md"), ":one\n:two");
      write(join(dir, "b.md"), `:three ${"x".repeat(500)}`);

      const result = scan(dir, { hits: 2, bytes: 1000 });
      expect(tagsOf(result.hits)).toEqual(["one", "two"]);
      // Only `a.md` consumed the budget. `b.md` was never opened.
      expect(result.truncated).toEqual(["hits"]);
    });

    it("does not report the ceiling for a taskspace that sits under it", () => {
      write(join(dir, "notes.md"), ":one\n:two");

      const result = scan(dir, { hits: 5 });
      expect(tagsOf(result.hits)).toEqual(["one", "two"]);
      expect(result.truncated).toEqual([]);
    });
  });

  describe("the cache", () => {
    it("answers the same on a second scan of an unchanged tree", () => {
      write(join(dir, "notes.md"), ":foo");

      const first = scan(dir);
      const second = scan(dir);
      expect(second.hits).toEqual(first.hits);
      expect(second.truncated).toEqual(first.truncated);
      // The second scan must report that it reused cached content so the caller knows no
      // write is needed.
      expect([first.changed, second.changed]).toEqual([true, false]);
    });

    it("does not spend budget re-reading an unchanged file", () => {
      write(join(dir, "a.md"), ":one");
      write(join(dir, "b.md"), ":two");
      // Budget for one file. The first scan reads only `a.md`. The second gets it from cache
      // and can read `b.md`.
      const bytes = ":one".length;

      const first = scan(dir, { bytes });
      expect(tagsOf(first.hits)).toEqual(["one"]);
      expect(first.truncated).toEqual(["budget"]);

      const second = scan(dir, { bytes });
      expect(tagsOf(second.hits)).toEqual(["one", "two"]);
      expect(second.truncated).toEqual([]);
    });

    it("picks up a file rewritten since it was cached", () => {
      const path = join(dir, "notes.md");
      write(path, ":before", 60);
      expect(tagsOf(scan(dir).hits)).toEqual(["before"]);

      write(path, ":after");
      expect(tagsOf(scan(dir).hits)).toEqual(["after"]);
    });

    it("picks up a file added since the last scan", () => {
      write(join(dir, "a.md"), ":one");
      expect(tagsOf(scan(dir).hits)).toEqual(["one"]);

      write(join(dir, "b.md"), ":two");
      expect(tagsOf(scan(dir).hits)).toEqual(["one", "two"]);
    });

    it("forgets a file deleted since the last scan", () => {
      const path = join(dir, "notes.md");
      write(path, ":foo");
      expect(tagsOf(scan(dir).hits)).toEqual(["foo"]);

      rmSync(path);
      expect(scan(dir).hits).toEqual([]);
    });

    /**
     * Remove deleted files from the persisted cache so it does not grow with every file ever
     * scanned.
     */
    it("forgets the stored entry for a file that is gone, not just its hits", () => {
      write(join(dir, "notes.md"), ":foo");
      scan(dir);
      expect(Object.keys(exportTaskspaceTagCache(dir) ?? {})).toEqual(["notes.md"]);

      rmSync(join(dir, "notes.md"));
      const after = scan(dir);

      expect(exportTaskspaceTagCache(dir)).toEqual({});
      // Dropping it is something learned, so the caller is told there is a new state to keep.
      expect(after.changed).toBe(true);
    });

    /** Do not prune entries from directories an incomplete scan did not reach. */
    it("keeps stored entries when the walk did not finish", () => {
      write(join(dir, "a.md"), ":one");
      write(join(dir, "b.md"), ":two");
      scan(dir);

      const truncated = scan(dir, { nodes: 1 });
      expect(truncated.truncated).toEqual(["nodes"]);
      expect(Object.keys(exportTaskspaceTagCache(dir) ?? {}).sort()).toEqual(["a.md", "b.md"]);
    });

    /**
     * Prune stale files in fully listed directories even if another part of the scan was
     * truncated.
     */
    it("forgets a file gone from a directory it listed, though the walk stopped elsewhere", () => {
      mkdirSync(join(dir, "sub"));
      write(join(dir, "notes.md"), ":one");
      write(join(dir, "sub", "deep.md"), ":two");
      scan(dir);
      expect(Object.keys(exportTaskspaceTagCache(dir) ?? {}).sort()).toEqual([
        "notes.md",
        "sub/deep.md",
      ]);

      rmSync(join(dir, "notes.md"));
      // Truncate below the depth limit while still completing the root listing.
      const after = scan(dir, { depth: 0 });

      expect(after.truncated).toEqual(["depth"]);
      // `notes.md` was gone from a directory this walk listed in full, so it is dropped.
      // `sub/deep.md` was never looked at, so nothing here says it is gone and it is kept.
      expect(Object.keys(exportTaskspaceTagCache(dir) ?? {})).toEqual(["sub/deep.md"]);
      expect(after.changed).toBe(true);
    });

    /**
     * A completed loop over a truncated listing is still incomplete. Preserve cached entries
     * that might lie beyond the listing limit.
     */
    it("keeps entries for a directory whose listing was cut short", () => {
      const sub = join(dir, "sub");
      mkdirSync(sub);
      // Two past the cap, so the listing is still truncated after one is removed below.
      const names = Array.from(
        { length: TASKSPACE_DIR_ENTRIES_MAX + 2 },
        (_, i) => `f${String(i).padStart(4, "0")}.md`,
      );
      for (const name of names) write(join(sub, name), ":one");

      expect(scan(dir).truncated).toContain("entries");
      expect(exportTaskspaceTagCache(dir)).toHaveProperty(["sub/f0000.md"]);

      rmSync(join(sub, names[0]));
      const after = scan(dir);

      expect(after.truncated).toContain("entries");
      // Keep the entry because an incomplete listing cannot establish that its file is gone.
      expect(exportTaskspaceTagCache(dir)).toHaveProperty(["sub/f0000.md"]);
    });

    it("keeps one taskspace's cache out of another's", () => {
      const other = join(tmpdir(), `kozane-taskspace-tags-other-${randomUUID()}`);
      mkdirSync(other, { recursive: true });
      try {
        write(join(dir, "notes.md"), ":here");
        write(join(other, "notes.md"), ":there");

        expect(tagsOf(scan(dir).hits)).toEqual(["here"]);
        expect(tagsOf(scan(other).hits)).toEqual(["there"]);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    /**
     * Bound the cache by directory. Pruning cannot remove entries for deleted or moved
     * taskspaces that are never walked again.
     */
    describe("its bound on directories", () => {
      /** One directory per scan, each holding one file, so the only thing varying is how many
       *  directories the map has been asked to hold. */
      const scanFresh = (base: string, n: number) => {
        const path = join(base, `ts-${n}`);
        mkdirSync(path, { recursive: true });
        write(join(path, "notes.md"), `:tag${n}`);
        scan(path);
        return path;
      };

      it("forgets the least recently scanned taskspace once it holds too many", () => {
        const first = scanFresh(dir, 0);
        expect(exportTaskspaceTagCache(first)).toBeDefined();

        // Scan one more directory than the cache limit to exercise eviction.
        for (let n = 1; n <= 64; n++) scanFresh(dir, n);

        expect(exportTaskspaceTagCache(first)).toBeUndefined();
        expect(exportTaskspaceTagCache(join(dir, "ts-64"))).toBeDefined();
      });

      it("keeps a taskspace that is still being looked at, however old it is", () => {
        const first = scanFresh(dir, 0);

        for (let n = 1; n <= 64; n++) {
          scanFresh(dir, n);
          // A cache-only scan must still refresh recency.
          scan(first);
        }

        expect(exportTaskspaceTagCache(first)).toBeDefined();
      });
    });

    /**
     * Bound cached files within each taskspace, including taskspaces that cannot be fully
     * scanned and pruned. Override `limits.files` to reach the limit with a small fixture.
     */
    describe("its bound on files within one taskspace", () => {
      it("keeps the most recently seen files and forgets the rest", () => {
        for (const name of ["a.md", "b.md", "c.md"]) write(join(dir, name), `:tag-${name}`);

        scan(dir, { files: 2 });

        // Walk order is the listing's, which `listTaskspaceDirectory` sorts, so `a.md` is the
        // one that fell off the front.
        expect(Object.keys(exportTaskspaceTagCache(dir) ?? {})).toEqual(["b.md", "c.md"]);
      });

      it("never drops a file the scan it is running has just parsed", () => {
        for (const name of ["a.md", "b.md", "c.md"]) write(join(dir, name), `:tag-${name}`);

        // Eviction affects later scans, not the hits returned by this scan. `:tag-a.md`
        // produces the tag `tag-a` because the period ends the tag.
        expect(tagsOf(scan(dir, { files: 1 }).hits)).toEqual(["tag-a", "tag-b", "tag-c"]);
      });

      it("keeps a file that is still there over one that has gone, across scans", () => {
        write(join(dir, "a.md"), ":gone");
        write(join(dir, "b.md"), ":kept");
        scan(dir, { files: 2 });

        rmSync(join(dir, "a.md"));
        // `b.md` is answered from the cache and writes nothing, so only a hit marking its
        // entry as used keeps it ahead of the entry for a file that is no longer there.
        scan(dir, { files: 1 });

        expect(Object.keys(exportTaskspaceTagCache(dir) ?? {})).toEqual(["b.md"]);
      });
    });
  });

  /**
   * The ceiling across a whole gather, on top of each taskspace's own. Without it a workspace
   * of a dozen taskspaces cost a dozen times the per-taskspace budget on one page load, and
   * the walk is synchronous, so the server answered nothing else while it ran.
   */
  describe("the shared pool", () => {
    it("spends from the pool, and reports the taskspace that found it empty", () => {
      const other = join(tmpdir(), `kozane-taskspace-tags-pool-${randomUUID()}`);
      mkdirSync(other, { recursive: true });
      try {
        write(join(dir, "notes.md"), ":first");
        write(join(other, "notes.md"), ":second");

        // Enough for the first taskspace's file and nothing after it.
        const pool = { bytes: 8, nodes: 100 };
        expect(tagsOf(scanTaskspaceTags(dir, TASKSPACE_ID, {}, pool).hits)).toEqual(["first"]);

        const starved = scanTaskspaceTags(other, "ts-2", {}, pool);
        expect(starved.hits).toEqual([]);
        expect(starved.truncated).toEqual(["budget"]);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("charges the pool nothing for a file answered from the cache", () => {
      write(join(dir, "notes.md"), ":first");
      scan(dir);

      const pool = { bytes: 0, nodes: 100 };
      const warm = scanTaskspaceTags(dir, TASKSPACE_ID, {}, pool);

      expect(tagsOf(warm.hits)).toEqual(["first"]);
      expect(warm.truncated).toEqual([]);
      expect(pool.bytes).toBe(0);
    });

    it("lets a taskspace spend no more than its own ceiling, however full the pool", () => {
      write(join(dir, "notes.md"), ":first and some more text to pay for");

      const pool = { bytes: 1_000_000, nodes: 100 };
      const scanned = scanTaskspaceTags(dir, TASKSPACE_ID, { bytes: 4 }, pool);

      expect(scanned.truncated).toEqual(["budget"]);
      // Only what the taskspace's own ceiling allowed can have come out of the pool.
      expect(pool.bytes).toBeGreaterThanOrEqual(1_000_000 - 4);
    });
  });
});
