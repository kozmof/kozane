import { describe, it, expect } from "vitest";
import { evict, evictRecord, setLast, touch, touchOrCreate } from "./lru.js";

/** Test least-recently-used ordering for both in-memory Maps and JSON-backed objects. */

const keysOf = <V>(map: Map<string, V>) => [...map.keys()];

describe("touch", () => {
  it("moves a key it holds to the end", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);

    touch(map, "a");

    expect(keysOf(map)).toEqual(["b", "c", "a"]);
  });

  /** An entry nobody has had to touch is exactly the one worth keeping, but creating one on
   *  the way past leaves a record for something that was never read. */
  it("leaves a key it does not hold absent", () => {
    const map = new Map([["a", 1]]);

    touch(map, "missing");

    expect(keysOf(map)).toEqual(["a"]);
  });
});

describe("touchOrCreate", () => {
  it("creates a key it does not hold, at the end", () => {
    const map = new Map([["a", 1]]);

    expect(touchOrCreate(map, "b", () => 2)).toBe(2);
    expect(keysOf(map)).toEqual(["a", "b"]);
  });

  it("keeps the value it holds, and moves it to the end", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);

    expect(
      touchOrCreate(map, "a", () => {
        throw new Error("must not be called for a key already held");
      }),
    ).toBe(1);
    expect(keysOf(map)).toEqual(["b", "a"]);
  });
});

describe("evict", () => {
  it("drops all but the last max, which are the ones least recently touched", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);

    evict(map, 2);

    expect(keysOf(map)).toEqual(["b", "c"]);
  });

  it("keeps everything when there is room", () => {
    const map = new Map([["a", 1]]);

    evict(map, 4);

    expect(keysOf(map)).toEqual(["a"]);
  });

  /**
   * A zero ceiling must retain no entries. With `max` set to zero, `slice(0, -max)` returns
   * an empty deletion list and would retain everything.
   */
  it("keeps nothing for a ceiling of zero", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);

    evict(map, 0);

    expect(keysOf(map)).toEqual([]);
  });
});

describe("setLast and evictRecord", () => {
  it("sets a key at the end, moving one already there", () => {
    const entries: Record<string, number> = { a: 1, b: 2 };

    setLast(entries, "a", 9);

    expect(Object.keys(entries)).toEqual(["b", "a"]);
    expect(entries.a).toBe(9);
  });

  it("evicts a record the way a map is evicted", () => {
    const entries: Record<string, number> = { a: 1, b: 2, c: 3 };

    evictRecord(entries, 2);

    expect(Object.keys(entries)).toEqual(["b", "c"]);
  });

  it("keeps nothing for a ceiling of zero", () => {
    const entries: Record<string, number> = { a: 1, b: 2 };

    evictRecord(entries, 0);

    expect(Object.keys(entries)).toEqual([]);
  });
});
