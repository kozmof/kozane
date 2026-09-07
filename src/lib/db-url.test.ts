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
    // The case the three `includes(":memory:")` call sites this replaced would have got
    // wrong: a real directory whose name happens to contain the token. Exempting it from
    // the migration gate would serve an unmigrated workspace, and from
    // `databaseSignature` would leave the tag cache unable to tell a stale gather from a
    // current one.
    expect(isMemoryDbUrl("file:/tmp/:memory:/kozane.db")).toBe(false);
    expect(isMemoryDbUrl("file:/home/u/.kozane/kozane.db")).toBe(false);
    expect(isMemoryDbUrl("")).toBe(false);
  });

  it("does not accept a prefix that only looks like one", () => {
    expect(isMemoryDbUrl("file::memory:extra")).toBe(false);
    expect(isMemoryDbUrl(":memory:extra")).toBe(false);
  });
});
