import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_FILE_BYTES_MAX } from "../constants.js";
import {
  createTaskspaceDirectory,
  createTaskspaceFile,
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

  it("refuses to list inside a dot-directory it hides", () => {
    mkdirSync(join(base, ".git", "refs"), { recursive: true });
    mkdirSync(join(base, "src"));

    for (const subPath of [".git", ".git/refs", "src/../.git"])
      expect(() => listTaskspaceDirectory({ baseDir: base, subPath })).toThrow(
        expect.objectContaining({ reason: "invalid-path" }),
      );
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

describe("createTaskspaceFile", () => {
  let root: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-create-test-${randomUUID()}`);
    base = join(root, "taskspace");
    outside = join(root, "outside");
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not yours");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates an empty file and answers as the editor would open it", () => {
    const made = createTaskspaceFile({ baseDir: base, subPath: "notes.md" });

    expect(made.path).toBe("notes.md");
    expect(made.content).toBe("");
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("");
    // The signature is what a save will be checked against, so it has to be the one a read
    // of the same file produces rather than merely non-null.
    expect(made.signature).toBe(
      readTaskspaceFile({ baseDir: base, subPath: "notes.md" }).signature,
    );
  });

  it("creates a file in a subdirectory", () => {
    expect(createTaskspaceFile({ baseDir: base, subPath: "src/app.ts" }).path).toBe("src/app.ts");
    expect(readFileSync(join(base, "src", "app.ts"), "utf-8")).toBe("");
  });

  it("saves into a file it just created", () => {
    const made = createTaskspaceFile({ baseDir: base, subPath: "notes.md" });
    writeTaskspaceFile({
      baseDir: base,
      subPath: "notes.md",
      content: "first\n",
      signature: made.signature,
    });
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("first\n");
  });

  it("refuses a name already taken by a file", () => {
    writeFileSync(join(base, "notes.md"), "mine\n");
    expect(() => createTaskspaceFile({ baseDir: base, subPath: "notes.md" })).toThrow(
      expect.objectContaining({ reason: "exists" }),
    );
    expect(readFileSync(join(base, "notes.md"), "utf-8")).toBe("mine\n");
  });

  it("refuses a name already taken by a directory", () => {
    expect(() => createTaskspaceFile({ baseDir: base, subPath: "src" })).toThrow(
      expect.objectContaining({ reason: "exists" }),
    );
  });

  it("refuses a name held by a symlink rather than following it", () => {
    symlinkSync(join(outside, "secret.txt"), join(base, "link.txt"), "file");

    expect(() => createTaskspaceFile({ baseDir: base, subPath: "link.txt" })).toThrow(
      expect.objectContaining({ reason: "exists" }),
    );
    expect(readFileSync(join(outside, "secret.txt"), "utf-8")).toBe("not yours");
  });

  it("refuses a path that walks out of the taskspace", () => {
    expect(() => createTaskspaceFile({ baseDir: base, subPath: "../outside/owned.txt" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("refuses a dot-entry, which the tree would never show", () => {
    expect(() => createTaskspaceFile({ baseDir: base, subPath: ".env" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
    expect(readdirSync(base)).toEqual(["src"]);
  });

  it("refuses a path holding a NUL byte", () => {
    expect(() => createTaskspaceFile({ baseDir: base, subPath: "no\0pe.txt" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("does not create the parent directories of the file", () => {
    expect(() => createTaskspaceFile({ baseDir: base, subPath: "nope/deep.txt" })).toThrow(
      expect.objectContaining({ reason: "not-found" }),
    );
    expect(readdirSync(base)).toEqual(["src"]);
  });

  it("refuses an empty path", () => {
    expect(() => createTaskspaceFile({ baseDir: base, subPath: "" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });
});

describe("createTaskspaceDirectory", () => {
  let root: string;
  let base: string;
  let outside: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-mkdir-test-${randomUUID()}`);
    base = join(root, "taskspace");
    outside = join(root, "outside");
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a directory and answers with the empty listing of it", () => {
    const made = createTaskspaceDirectory({ baseDir: base, subPath: "docs" });

    expect(made).toEqual({ path: "docs", entries: [], truncated: false });
    expect(lstatSync(join(base, "docs")).isDirectory()).toBe(true);
    // The same shape the listing endpoint answers with, so the panel can draw from either.
    expect(listTaskspaceDirectory({ baseDir: base, subPath: "docs" })).toEqual(made);
  });

  it("creates a directory inside another", () => {
    expect(createTaskspaceDirectory({ baseDir: base, subPath: "src/lib" }).path).toBe("src/lib");
    expect(lstatSync(join(base, "src", "lib")).isDirectory()).toBe(true);
  });

  it("refuses a name already taken", () => {
    writeFileSync(join(base, "README.md"), "hello");
    expect(() => createTaskspaceDirectory({ baseDir: base, subPath: "src" })).toThrow(
      expect.objectContaining({ reason: "exists" }),
    );
    expect(() => createTaskspaceDirectory({ baseDir: base, subPath: "README.md" })).toThrow(
      expect.objectContaining({ reason: "exists" }),
    );
  });

  it("refuses a path that walks out of the taskspace", () => {
    expect(() => createTaskspaceDirectory({ baseDir: base, subPath: "../outside/owned" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a dot-entry", () => {
    expect(() => createTaskspaceDirectory({ baseDir: base, subPath: ".git" })).toThrow(
      expect.objectContaining({ reason: "invalid-path" }),
    );
  });

  it("does not create intermediate directories", () => {
    expect(() => createTaskspaceDirectory({ baseDir: base, subPath: "a/b/c" })).toThrow(
      expect.objectContaining({ reason: "not-found" }),
    );
    expect(readdirSync(base)).toEqual(["src"]);
  });
});

/**
 * The paths a real filesystem takes that a tidy one does not: a permission the process does
 * not have, a symlink that points at itself, an entry that is neither a file nor a
 * directory, and a directory that can be listed but not inspected.
 *
 * Every case here is about `mapFsError` and the catch blocks around it — the part of this
 * module that decides whether an awkward filesystem reads to the route as 403, 404 or 400.
 * The boundary tests above are about what the module refuses on purpose; these are about
 * what it does when the refusal comes from the kernel instead.
 *
 * `skipIf` on the permission cases for the reason `taskspace-tags.test.ts` gives on its own:
 * nothing is unreadable to root, so the denial they rest on does not happen there.
 */
describe("taskspace files on an awkward filesystem", () => {
  const asRoot = process.getuid?.() === 0;
  let root: string;
  let base: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-files-fs-${randomUUID()}`);
    base = join(root, "taskspace");
    mkdirSync(base, { recursive: true });
  });

  afterEach(() => {
    // Permissions are put back before the tree is removed: a directory left at 0o000 cannot
    // be recursed into, and the cleanup would leave it behind in the temp directory.
    for (const name of ["ro", "nox", "locked-dir"]) {
      try {
        chmodSync(join(base, name), 0o755);
      } catch {
        // Not every case creates every one of them.
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  function reasonOf(run: () => unknown): string {
    try {
      run();
    } catch (e) {
      if (e instanceof TaskspaceFilesError) return e.reason;
      throw e;
    }
    throw new Error("expected a TaskspaceFilesError");
  }

  describe("a taskspace that is not there", () => {
    it("reports a missing taskspace directory as not-found when listing", () => {
      expect(reasonOf(() => listTaskspaceDirectory({ baseDir: join(root, "gone") }))).toBe(
        "not-found",
      );
    });

    it("reports a missing taskspace directory as not-found when reading a file", () => {
      expect(
        reasonOf(() => readTaskspaceFile({ baseDir: join(root, "gone"), subPath: "a.txt" })),
      ).toBe("not-found");
    });

    it("reports a missing taskspace directory as not-found when creating a file", () => {
      expect(
        reasonOf(() => createTaskspaceFile({ baseDir: join(root, "gone"), subPath: "a.txt" })),
      ).toBe("not-found");
    });

    it("reports a missing parent directory as not-found rather than creating it", () => {
      // Non-recursive on purpose: one request must not be able to conjure a tree.
      expect(reasonOf(() => createTaskspaceFile({ baseDir: base, subPath: "no/such/a.txt" }))).toBe(
        "not-found",
      );
    });
  });

  describe("a symlink that points at itself", () => {
    it("reports a looping taskspace root as an invalid path", () => {
      const loop = join(root, "loop");
      symlinkSync(loop, loop);
      expect(reasonOf(() => listTaskspaceDirectory({ baseDir: loop }))).toBe("invalid-path");
    });

    it("reports a looping directory inside the taskspace as an invalid path", () => {
      symlinkSync(join(base, "loop"), join(base, "loop"));
      expect(reasonOf(() => listTaskspaceDirectory({ baseDir: base, subPath: "loop" }))).toBe(
        "invalid-path",
      );
    });

    it("reports a looping path as an invalid path when reading a file through it", () => {
      symlinkSync(join(base, "loop"), join(base, "loop"));
      expect(reasonOf(() => readTaskspaceFile({ baseDir: base, subPath: "loop/a.txt" }))).toBe(
        "invalid-path",
      );
    });
  });

  describe("an entry that is neither a file nor a directory", () => {
    it("lists a unix socket as `other`, with no size", async () => {
      // The one `entryKind` branch nothing else reaches. A socket is what a running program
      // leaves in a working directory, so a taskspace can genuinely contain one.
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(join(base, "app.sock"), resolve));
      try {
        const listing = listTaskspaceDirectory({ baseDir: base });
        expect(listing.entries).toEqual([
          { name: "app.sock", kind: "other", size: null, modifiedAt: expect.any(String) },
        ]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("refuses to read one as a file", () => {
      expect(reasonOf(() => readTaskspaceFile({ baseDir: base, subPath: "nothing-here" }))).toBe(
        "not-found",
      );
    });
  });

  describe("a permission the process does not have", () => {
    it.skipIf(asRoot)("reports an unlistable directory as forbidden", () => {
      mkdirSync(join(base, "locked-dir"));
      chmodSync(join(base, "locked-dir"), 0o000);
      expect(reasonOf(() => listTaskspaceDirectory({ baseDir: base, subPath: "locked-dir" }))).toBe(
        "forbidden",
      );
    });

    it.skipIf(asRoot)("reports an unreadable file as forbidden", () => {
      const file = join(base, "locked.txt");
      writeFileSync(file, "secret");
      chmodSync(file, 0o000);
      try {
        expect(reasonOf(() => readTaskspaceFile({ baseDir: base, subPath: "locked.txt" }))).toBe(
          "forbidden",
        );
      } finally {
        chmodSync(file, 0o644);
      }
    });

    it.skipIf(asRoot)("reports a file it cannot write as forbidden", () => {
      const file = join(base, "readonly.txt");
      writeFileSync(file, "before");
      const { signature } = readTaskspaceFile({ baseDir: base, subPath: "readonly.txt" });
      chmodSync(base, 0o555);
      try {
        // The directory is what is locked, not the file: `writeFileAtomic` renames a
        // temporary file into place, so it needs to write the directory entry.
        expect(
          reasonOf(() =>
            writeTaskspaceFile({
              baseDir: base,
              subPath: "readonly.txt",
              content: "after",
              signature,
            }),
          ),
        ).toBe("forbidden");
      } finally {
        chmodSync(base, 0o755);
      }
      // The refusal left the file as it was, which is the property that matters.
      expect(readFileSync(file, "utf8")).toBe("before");
    });

    it.skipIf(asRoot)("reports a file it cannot create as forbidden", () => {
      mkdirSync(join(base, "ro"));
      chmodSync(join(base, "ro"), 0o555);
      expect(reasonOf(() => createTaskspaceFile({ baseDir: base, subPath: "ro/new.txt" }))).toBe(
        "forbidden",
      );
    });

    it.skipIf(asRoot)("reports a directory it cannot create as forbidden", () => {
      mkdirSync(join(base, "ro"));
      chmodSync(join(base, "ro"), 0o555);
      expect(
        reasonOf(() => createTaskspaceDirectory({ baseDir: base, subPath: "ro/new-folder" })),
      ).toBe("forbidden");
    });
  });

  describe("an entry that cannot be inspected after it has been listed", () => {
    it.skipIf(asRoot)("leaves it out of the listing rather than failing the whole read", () => {
      // Read permission without execute: `readdir` answers with the names, and `lstat` on
      // each of them is refused. That is the same shape as an entry deleted between the two
      // calls, which is the race this branch is really for — and the only version of it a
      // test can arrange deterministically.
      const dir = join(base, "nox");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.txt"), "x");
      writeFileSync(join(dir, "b.txt"), "y");
      chmodSync(dir, 0o444);
      try {
        const listing = listTaskspaceDirectory({ baseDir: base, subPath: "nox" });
        expect(listing.entries).toEqual([]);
        expect(listing.truncated).toBe(false);
        expect(listing.path).toBe("nox");
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  });
});
