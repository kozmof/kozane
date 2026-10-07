import { describe, expect, it } from "vitest";
import { isMemoryDbUrl } from "./db-url.js";

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
