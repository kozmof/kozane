import { describe, expect, it } from "vitest";
import { splitCardContent, squashCardPositions } from "./card";

describe("card squash", () => {
  it("splits on full stops and empty lines", () => {
    expect(
      splitCardContent("First paragraph\ncontinues here.\n\nSecond paragraph\n\n\n第三。"),
    ).toEqual(["First paragraph\ncontinues here", "Second paragraph", "第三"]);
  });

  it("places cards on distinct grid positions", () => {
    expect(squashCardPositions([], 3)).toEqual([
      { posX: 0, posY: 0 },
      { posX: 280, posY: 0 },
      { posX: 560, posY: 0 },
    ]);
  });

  it("skips grid positions already occupied", () => {
    expect(
      squashCardPositions(
        [
          { posX: 0, posY: 0 },
          { posX: 280, posY: 0 },
        ],
        2,
      ),
    ).toEqual([
      { posX: 560, posY: 0 },
      { posX: 840, posY: 0 },
    ]);
  });
});
