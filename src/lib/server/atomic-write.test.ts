import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write.js";
import { fileSignature } from "./file-signature.js";

let dir: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kozane-atomic-write-"));
  target = join(dir, "file.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes the contents", () => {
    writeFileAtomic(target, "hello\n");
    expect(readFileSync(target, "utf-8")).toBe("hello\n");
  });

  it("replaces an existing file", () => {
    writeFileSync(target, "old");
    writeFileAtomic(target, "new");
    expect(readFileSync(target, "utf-8")).toBe("new");
  });

  it("leaves no temporary behind", () => {
    writeFileAtomic(target, "hello");
    expect(readdirSync(dir)).toEqual(["file.json"]);
  });

  it("leaves no temporary behind when the write fails", () => {
    expect(() => writeFileAtomic(target, "x", { mode: -1 })).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("applies the requested mode despite the umask", () => {
    writeFileAtomic(target, "secret", { mode: 0o600 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  // Compared against a plain write rather than against fixed bits, which would only be
  // asserting this machine's umask. The point is that a *new* file is left to the umask,
  // exactly as a plain write would leave it.
  it("leaves permissions to the umask for a file that did not exist", () => {
    const reference = join(dir, "reference.json");
    writeFileSync(reference, "public");
    writeFileAtomic(target, "public");
    expect(statSync(target).mode & 0o777).toBe(statSync(reference).mode & 0o777);
  });

  // The rename gives the target a new inode, so without carrying the mode over the new file
  // arrives with whatever the umask says and the old permissions are simply gone.
  it("keeps the permissions of the file it replaces", () => {
    writeFileSync(target, "old", { mode: 0o640 });
    chmodSync(target, 0o640);

    writeFileAtomic(target, "new");

    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  // The case this is actually for: a taskspace holds ordinary working files, and saving a
  // script through the browser editor must not quietly take away the bit that runs it.
  it("leaves an executable file executable", () => {
    writeFileSync(target, "#!/bin/sh\necho old\n");
    chmodSync(target, 0o755);

    writeFileAtomic(target, "#!/bin/sh\necho new\n");

    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho new\n");
  });

  it("prefers an explicitly requested mode over the one already there", () => {
    writeFileSync(target, "old");
    chmodSync(target, 0o644);

    writeFileAtomic(target, "secret", { mode: 0o600 });

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  // The reason writeConfig uses this. Two writes of the same length land in one filesystem
  // timestamp tick, and an in-place rewrite keeps the inode, so mtime and size cannot tell
  // them apart — the rename is what gives the second one an identity of its own.
  it("gives a same-length rewrite a signature of its own", () => {
    writeFileAtomic(target, '{"contentMax":20000}');
    const first = fileSignature(target);
    writeFileAtomic(target, '{"contentMax":30000}');
    const second = fileSignature(target);

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("is what an in-place write of the same length cannot do", () => {
    writeFileSync(target, '{"contentMax":20000}');
    const first = fileSignature(target);
    writeFileSync(target, '{"contentMax":30000}');

    // Not asserted as equal — a slow enough machine ticks the clock between the two. The
    // point is only that writeFileAtomic does not depend on the outcome.
    expect(readFileSync(target, "utf-8")).toBe('{"contentMax":30000}');
    expect(first).not.toBeNull();
  });

  // Back-to-back writes share a pid and a millisecond, so the temporary name needs
  // something more than those two to stay unique — otherwise the second `wx` open finds
  // the first one's file still there.
  it("survives many writes in a row", () => {
    for (let index = 0; index < 50; index++) writeFileAtomic(target, `write ${index}`);
    expect(readFileSync(target, "utf-8")).toBe("write 49");
    expect(readdirSync(dir)).toEqual(["file.json"]);
  });

  it("reports a write into a missing directory rather than half-doing it", () => {
    expect(() => writeFileAtomic(join(dir, "nope", "file.json"), "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
