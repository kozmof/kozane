import { describe, expect, it } from "vitest";
import { dbPathFromUrl, fileDbUrl, isMemoryDbUrl } from "./db-url.js";

describe("isMemoryDbUrl", () => {
  it("accepts the libsql in-memory spellings", () => {
    expect(isMemoryDbUrl(":memory:")).toBe(true);
    expect(isMemoryDbUrl("file::memory:")).toBe(true);
    expect(isMemoryDbUrl("file::memory:?cache=shared")).toBe(true);
    expect(isMemoryDbUrl("file::memory:?cache=private&mode=memory")).toBe(true);
  });

  it("treats a file path as a file, even one spelling :memory: inside it", () => {
    // A real directory containing `:memory:` must still pass the migration gate and
    // invalidate stale tag caches when its database changes.
    expect(isMemoryDbUrl("file:/tmp/:memory:/kozane.db")).toBe(false);
    expect(isMemoryDbUrl("file:/home/u/.kozane/kozane.db")).toBe(false);
    expect(isMemoryDbUrl("")).toBe(false);
  });

  it("does not accept a prefix that only looks like one", () => {
    expect(isMemoryDbUrl("file::memory:extra")).toBe(false);
    expect(isMemoryDbUrl(":memory:extra")).toBe(false);
  });
});

describe("fileDbUrl and dbPathFromUrl", () => {
  it("round-trips a path holding characters a raw URL would misread", () => {
    const path = "/tmp/a%41 b#c?d/kozane.db";
    const url = fileDbUrl(path);
    expect(url).not.toContain("#");
    expect(dbPathFromUrl(url)).toBe(path);
  });

  it("reads the bare form a hand-written DATABASE_URL may use", () => {
    expect(dbPathFromUrl("file:/home/u/.kozane/kozane.db")).toBe("/home/u/.kozane/kozane.db");
    expect(dbPathFromUrl("file:/home/u/my%20db.db?mode=ro")).toBe("/home/u/my db.db");
  });

  it("names no path for in-memory or remote databases", () => {
    expect(dbPathFromUrl(":memory:")).toBeNull();
    expect(dbPathFromUrl("file::memory:?cache=shared")).toBeNull();
    expect(dbPathFromUrl("libsql://example.turso.io")).toBeNull();
  });
});
