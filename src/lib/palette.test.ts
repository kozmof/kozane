import { describe, expect, it } from "vitest";
import { applyPalette, PALETTE } from "./palette.js";

describe("applyPalette", () => {
  it("adds palette colors and wraps when there are more partitions than colors", () => {
    const partitions = Array.from({ length: PALETTE.length + 1 }, (_, i) => ({
      id: `partition-${i}`,
      name: `Partition ${i}`,
    }));

    const result = applyPalette(partitions);

    expect(result[0]).toEqual({ ...partitions[0], ...PALETTE[0] });
    expect(result[PALETTE.length]).toEqual({ ...partitions[PALETTE.length], ...PALETTE[0] });
  });

  /**
   * Partition colour depends only on list position so the map, tag index, and board assign it
   * consistently.
   */
  it("colors by position alone, and leaves the partition's own fields untouched", () => {
    const partitions = [
      { id: "z-last", name: "Zeta", isDefault: false },
      { id: "a-first", name: "Alpha", isDefault: true },
    ];

    const result = applyPalette(partitions);

    expect(result.map(({ bg }) => bg)).toEqual([PALETTE[0].bg, PALETTE[1].bg]);
    expect(result[1]).toMatchObject({ id: "a-first", name: "Alpha", isDefault: true });
  });

  it("returns an empty list for a namespace with no partitions", () => {
    expect(applyPalette([])).toEqual([]);
  });
});
