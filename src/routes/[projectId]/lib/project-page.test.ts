import { describe, expect, it } from "vitest";
import { applyPalette, glueIdByCardId, PALETTE } from "./project-page.js";

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
});

describe("glueIdByCardId", () => {
  it("indexes glue relationship ids by card id", () => {
    expect(
      glueIdByCardId([
        { cardId: "card-1", glueId: "glue-1" },
        { cardId: "card-2", glueId: "glue-2" },
      ]),
    ).toEqual(
      new Map([
        ["card-1", "glue-1"],
        ["card-2", "glue-2"],
      ]),
    );
  });
});
