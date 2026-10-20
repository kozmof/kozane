import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { databaseSignature, fileSignature } from "./file-signature";

const roots: string[] = [];

/** A directory of this test's own, removed afterwards. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-file-signature-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("fileSignature", () => {
  it("is null for a path with nothing at it", () => {
    expect(fileSignature(join(tempRoot(), "absent"))).toBeNull();
  });

  it("changes when the bytes do, and not otherwise", () => {
    const path = join(tempRoot(), "a.db");
    writeFileSync(path, "one");
    const first = fileSignature(path);
    expect(first).not.toBeNull();
    expect(fileSignature(path)).toBe(first);

    writeFileSync(path, "a longer body");
    expect(fileSignature(path)).not.toBe(first);
  });
});

describe("databaseSignature", () => {
  it("is null for an in-memory database, which has no file to sign", () => {
    expect(databaseSignature(":memory:")).toBeNull();
    expect(databaseSignature("file::memory:")).toBeNull();
  });

  it("signs the main file and its -wal together", () => {
    const path = join(tempRoot(), "kozane.db");
    writeFileSync(path, "main");
    const withoutWal = databaseSignature(`file:${path}`);
    expect(withoutWal).not.toBeNull();

    // Under WAL a commit appends to the log and leaves the main file alone, so the signature
    // has to move on the sidecar or an actively-written database reads as unchanged.
    writeFileSync(`${path}-wal`, "log");
    expect(databaseSignature(`file:${path}`)).not.toBe(withoutWal);
  });

  it("changes on every WAL commit, even when the -wal file's size and mtime do not", async () => {
    const path = join(tempRoot(), "kozane.db");
    const client = createClient({ url: `file:${path}` });
    try {
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      await client.execute("INSERT INTO t VALUES (1, 'a')");
      // Grow the log, then checkpoint so later commits rewrite it from the start at a steady
      // size. Back-to-back commits then often land in one mtime tick as well.
      for (let i = 0; i < 20; i++) await client.execute("UPDATE t SET v = 'b' WHERE id = 1");
      await client.execute("PRAGMA wal_checkpoint(PASSIVE)");

      for (let i = 0; i < 200; i++) {
        const before = databaseSignature(`file:${path}`);
        await client.execute({ sql: "UPDATE t SET v = ? WHERE id = 1", args: [String(i % 2)] });
        expect(databaseSignature(`file:${path}`)).not.toBe(before);
      }
    } finally {
      client.close();
    }
  });

  it("ignores the query parameters libsql allows after the path", () => {
    const path = join(tempRoot(), "kozane.db");
    writeFileSync(path, "main");
    expect(databaseSignature(`file:${path}?mode=ro`)).toBe(databaseSignature(`file:${path}`));
  });

  /**
   * Verify that percent-encoded file paths produce signatures, including workspace paths
   * containing spaces.
   */
  it("signs a path whose URL form is percent-encoded", () => {
    const dir = join(tempRoot(), "my notes");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "kozane.db");
    writeFileSync(path, "main");

    const encoded = `file:${path.split("/").map(encodeURIComponent).join("/")}`;
    expect(encoded).toContain("%20");
    expect(databaseSignature(encoded)).toBe(databaseSignature(`file:${path}`));
  });

  it("falls back to the raw path when the URL is not valid percent-encoding", () => {
    // Handle malformed percent encoding without failing the request. A missing file has no
    // signature and bypasses the cache gate.
    expect(databaseSignature("file:/nowhere/100%/kozane.db")).toBeNull();
  });
});
