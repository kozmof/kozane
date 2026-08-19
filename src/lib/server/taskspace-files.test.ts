import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { TASKSPACE_DIR_ENTRIES_MAX } from "../constants.js";
import { listTaskspaceDirectory, TaskspaceFilesError } from "./taskspace-files.js";

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
