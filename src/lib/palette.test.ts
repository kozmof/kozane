import { describe, expect, it } from "vitest";
import { applyPalette, PALETTE } from "./palette.js";

describe("applyPalette", () => {
  it("adds palette colors and wraps when there are more bundles than colors", () => {
    const bundles = Array.from({ length: PALETTE.length + 1 }, (_, i) => ({
      id: `bundle-${i}`,
      name: `Bundle ${i}`,
    }));

    const result = applyPalette(bundles);

    expect(result[0]).toEqual({ ...bundles[0], ...PALETTE[0] });
    expect(result[PALETTE.length]).toEqual({ ...bundles[PALETTE.length], ...PALETTE[0] });
  });

  /**
   * The property the map, the tag index and the board all depend on: a bundle's colour is
   * its index in the list, and nothing else. Three readers apply this to `getAllBundles`
   * output independently, so a colour that varied with anything but position would show the
   * same bundle in two colours on two pages.
   */
  it("colors by position alone, and leaves the bundle's own fields untouched", () => {
    const bundles = [
      { id: "z-last", name: "Zeta", isDefault: false },
      { id: "a-first", name: "Alpha", isDefault: true },
    ];

    const result = applyPalette(bundles);

    expect(result.map(({ bg }) => bg)).toEqual([PALETTE[0].bg, PALETTE[1].bg]);
    expect(result[1]).toMatchObject({ id: "a-first", name: "Alpha", isDefault: true });
  });

  it("returns an empty list for a project with no bundles", () => {
    expect(applyPalette([])).toEqual([]);
  });
});
