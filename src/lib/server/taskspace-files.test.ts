import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_FILE_BYTES_MAX } from "../constants.js";
import {
  listTaskspaceDirectory,
  readTaskspaceFile,
  TaskspaceFilesError,
  writeTaskspaceFile,
} from "./taskspace-files.js";

describe("listTaskspaceDirectory", () => {
  let root: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-files-test-${randomUUID()}`);
    base = join(root, "taskspace");
    outside = join(root, "outside");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not yours");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function names(subPath?: string): string[] {
    return listTaskspaceDirectory({ baseDir: base, subPath }).entries.map(({ name }) => name);
  }

  it("lists directories before files, each sorted by name", () => {
    mkdirSync(join(base, "src"));
    mkdirSync(join(base, "assets"));
    writeFileSync(join(base, "README.md"), "hello");
    writeFileSync(join(base, "app.ts"), "export {}");

    expect(names()).toEqual(["assets", "src", "app.ts", "README.md"]);
  });

  it("hides dot-entries", () => {
    writeFileSync(join(base, ".taskspace.json"), "{}");
    writeFileSync(join(base, ".env"), "SECRET=1");
    mkdirSync(join(base, ".git"));
    writeFileSync(join(base, "notes.md"), "kept");

    expect(names()).toEqual(["notes.md"]);
  });

  it("reports the listed path relative to the taskspace root", () => {
    mkdirSync(join(base, "src", "lib"), { recursive: true });
    writeFileSync(join(base, "src", "lib", "util.ts"), "export {}");

    const listing = listTaskspaceDirectory({ baseDir: base, subPath: "src/lib" });
    expect(listing.path).toBe("src/lib");
    expect(listing.entries).toEqual([
      { name: "util.ts", kind: "file", size: 9, modifiedAt: expect.any(String) },
    ]);
  });

  it("gives files a size and directories none", () => {
    mkdirSync(join(base, "src"));
    writeFileSync(join(base, "app.ts"), "abcde");

    const [dir, file] = listTaskspaceDirectory({ baseDir: base }).entries;
    expect(dir).toMatchObject({ name: "src", kind: "directory", size: null });
    expect(file).toMatchObject({ name: "app.ts", kind: "file", size: 5 });
  });

  it("refuses a path that walks out of the taskspace", () => {
    expect(() => listTaskspaceDirectory({ baseDir: base, subPath: "../outside" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("refuses an absolute path", () => {
    expect(() => listTaskspaceDirectory({ baseDir: base, subPath: outside })).toThrow(
      TaskspaceFilesError,
    );
  });

  it("labels a symlink as itself rather than as its target", () => {
    mkdirSync(join(base, "real"));
    symlinkSync(outside, join(base, "link"), "dir");

    expect(listTaskspaceDirectory({ baseDir: base }).entries).toEqual([
      { name: "real", kind: "directory", size: null, modifiedAt: expect.any(String) },
      { name: "link", kind: "symlink", size: null, modifiedAt: expect.any(String) },
    ]);
  });

  it("refuses to list through a symlink pointing outside the taskspace", () => {
    symlinkSync(outside, join(base, "link"), "dir");

    expect(() => listTaskspaceDirectory({ baseDir: base, subPath: "link" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("follows a symlink that stays inside the taskspace", () => {
    mkdirSync(join(base, "real"));
    writeFileSync(join(base, "real", "inside.txt"), "ok");
    symlinkSync(join(base, "real"), join(base, "link"), "dir");

    expect(names("link")).toEqual(["inside.txt"]);
  });

  it("caps a large directory and says it did", () => {
    for (let i = 0; i < TASKSPACE_DIR_ENTRIES_MAX + 1; i++) {
      writeFileSync(join(base, `f${String(i).padStart(4, "0")}.txt`), "");
    }

    const listing = listTaskspaceDirectory({ baseDir: base });
    expect(listing.entries).toHaveLength(TASKSPACE_DIR_ENTRIES_MAX);
    expect(listing.truncated).toBe(true);
    expect(listing.entries[0].name).toBe("f0000.txt");
  });

  it("does not flag a directory that fits", () => {
    writeFileSync(join(base, "only.txt"), "");
    expect(listTaskspaceDirectory({ baseDir: base }).truncated).toBe(false);
  });

  it("reports a missing taskspace directory as not found", () => {
    rmSync(base, { recursive: true, force: true });
    expect(() => listTaskspaceDirectory({ baseDir: base })).toThrow(
      expect.objectContaining({ reason: "not-found" }),
    );
  });

  it("reports a missing subdirectory as not found", () => {
    expect(() => listTaskspaceDirectory({ baseDir: base, subPath: "nope" })).toThrow(
      expect.objectContaining({ reason: "not-found" }),
    );
  });

  it("refuses a path that names a file", () => {
    writeFileSync(join(base, "app.ts"), "export {}");
    expect(() => listTaskspaceDirectory({ baseDir: base, subPath: "app.ts" })).toThrow(
      expect.objectContaining({ reason: "invalid-path", message: "Not a directory" }),
    );
  });
});

describe("readTaskspaceFile / writeTaskspaceFile", () => {
  let root: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-file-test-${randomUUID()}`);
    base = join(root, "taskspace");
    outside = join(root, "outside");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not yours");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function read(subPath: string) {
    return readTaskspaceFile({ baseDir: base, subPath });
  }

  it("reads a file and reports its path relative to the taskspace root", () => {
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "src", "app.ts"), "export {}\n");

    const file = read("src/app.ts");
    expect(file.path).toBe("src/app.ts");
    expect(file.content).toBe("export {}\n");
    expect(file.signature).toEqual(expect.any(String));
  });

  it("round-trips multi-byte text without mangling it", () => {
    writeFileSync(join(base, "notes.md"), "こざね法\n");
    expect(read("notes.md").content).toBe("こざね法\n");
  });

  it("refuses to walk out of the taskspace with ..", () => {
    expect(() => read("../outside/secret.txt")).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("refuses a symlink pointing out of the taskspace", () => {
    symlinkSync(join(outside, "secret.txt"), join(base, "escape.txt"));
    expect(() => read("escape.txt")).toThrow(expect.objectContaining({ reason: "invalid-path" }));
  });

  it("refuses a file reached through a symlinked directory that leaves the taskspace", () => {
    symlinkSync(outside, join(base, "elsewhere"));
    expect(() => read("elsewhere/secret.txt")).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("refuses dot-entries the listing hides", () => {
    writeFileSync(join(base, ".env"), "SECRET=1");
    writeFileSync(join(base, ".taskspace.json"), "{}");
    expect(() => read(".env")).toThrow(expect.objectContaining({ reason: "invalid-path" }));
    expect(() => read(".taskspace.json")).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("refuses a dot-directory anywhere along the path", () => {
    mkdirSync(join(base, ".git"), { recursive: true });
    writeFileSync(join(base, ".git", "config"), "[core]");
    expect(() => read(".git/config")).toThrow(expect.objectContaining({ reason: "invalid-path" }));
  });

  it("refuses a path naming no file", () => {
    expect(() => read("")).toThrow(expect.objectContaining({ reason: "invalid-path" }));
  });

  it("refuses a directory", () => {
    mkdirSync(join(base, "src"));
    expect(() => read("src")).toThrow(
      expect.objectContaining({ reason: "invalid-path", message: "Not a regular file" }),
    );
  });

  it("reports a missing file as not found", () => {
    expect(() => read("nope.txt")).toThrow(expect.objectContaining({ reason: "not-found" }));
  });

  it("refuses a file larger than the cap without reading it", () => {
    writeFileSync(join(base, "big.bin"), "x".repeat(TASKSPACE_FILE_BYTES_MAX + 1));
    expect(() => read("big.bin")).toThrow(expect.objectContaining({ reason: "too-large" }));
  });

  it("accepts a file exactly at the cap", () => {
    writeFileSync(join(base, "edge.txt"), "x".repeat(TASKSPACE_FILE_BYTES_MAX));
    expect(read("edge.txt").content.length).toBe(TASKSPACE_FILE_BYTES_MAX);
  });

  it("refuses a file holding a NUL byte", () => {
    writeFileSync(join(base, "data.bin"), Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    expect(() => read("data.bin")).toThrow(expect.objectContaining({ reason: "not-text" }));
  });

  it("refuses a file that is not valid UTF-8", () => {
    writeFileSync(join(base, "latin1.txt"), Buffer.from([0x68, 0x69, 0xff, 0xfe]));
    expect(() => read("latin1.txt")).toThrow(expect.objectContaining({ reason: "not-text" }));
  });

  it("saves over a file and hands back a signature that has moved", () => {
    writeFileSync(join(base, "notes.md"), "before\n");
    const opened = read("notes.md");

    const saved = writeTaskspaceFile({
      baseDir: base,
      subPath: "notes.md",
      content: "after\n",
      signature: opened.signature,
    });

    expect(saved.path).toBe("notes.md");
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("after\n");
    expect(saved.signature).not.toBe(opened.signature);
    expect(read("notes.md").signature).toBe(saved.signature);
  });

  it("refuses a save whose signature no longer matches what is on disk", () => {
    writeFileSync(join(base, "notes.md"), "before\n");
    const opened = read("notes.md");
    writeFileSync(join(base, "notes.md"), "changed underneath\n");

    expect(() =>
      writeTaskspaceFile({
        baseDir: base,
        subPath: "notes.md",
        content: "after\n",
        signature: opened.signature,
      }),
    ).toThrow(expect.objectContaining({ reason: "stale" }));
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("changed underneath\n");
  });

  it("refuses to create a file that is not already there", () => {
    expect(() =>
      writeTaskspaceFile({ baseDir: base, subPath: "new.md", content: "hi", signature: null }),
    ).toThrow(expect.objectContaining({ reason: "not-found" }));
  });

  it("refuses to write outside the taskspace", () => {
    expect(() =>
      writeTaskspaceFile({
        baseDir: base,
        subPath: "../outside/secret.txt",
        content: "owned",
        signature: null,
      }),
    ).toThrow(expect.objectContaining({ reason: "invalid-path" }));
    expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("not yours");
  });

  it("refuses to write content holding a NUL byte", () => {
    writeFileSync(join(base, "notes.md"), "before\n");
    const opened = read("notes.md");
    expect(() =>
      writeTaskspaceFile({
        baseDir: base,
        subPath: "notes.md",
        content: "bad\0bytes",
        signature: opened.signature,
      }),
    ).toThrow(expect.objectContaining({ reason: "not-text" }));
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("before\n");
  });

  it("refuses to write content larger than the cap", () => {
    writeFileSync(join(base, "notes.md"), "before\n");
    const opened = read("notes.md");
    expect(() =>
      writeTaskspaceFile({
        baseDir: base,
        subPath: "notes.md",
        content: "x".repeat(TASKSPACE_FILE_BYTES_MAX + 1),
        signature: opened.signature,
      }),
    ).toThrow(expect.objectContaining({ reason: "too-large" }));
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("before\n");
  });

  it("leaves no temporary file behind after a save", () => {
    writeFileSync(join(base, "notes.md"), "before\n");
    const opened = read("notes.md");
    writeTaskspaceFile({
      baseDir: base,
      subPath: "notes.md",
      content: "after\n",
      signature: opened.signature,
    });
    expect(readdirSync(base)).toEqual(["notes.md"]);
  });
});
