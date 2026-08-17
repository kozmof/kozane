import { describe, expect, it } from "vitest";
import { splitCardContent, squashCardPositions } from "./squash";
import { CANVAS_W } from "./constants";

describe("splitCardContent", () => {
  it("splits on period-space, Japanese full stops, and blank lines by default", () => {
    expect(splitCardContent("Visit example.com. Then read this。最後\n\nNew paragraph")).toEqual([
      "Visit example.com",
      "Then read this",
      "最後",
      "New paragraph",
    ]);
  });

  it("accepts a custom separator regex", () => {
    expect(splitCardContent("first | second,third", String.raw`\s*[|,]\s*`)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("yields a single segment for text the pattern does not match", () => {
    expect(splitCardContent("One indivisible thought")).toEqual(["One indivisible thought"]);
  });
});

describe("squashCardPositions", () => {
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

  it("lays the grid out from an origin", () => {
    expect(squashCardPositions([], 2, { origin: { posX: 1000, posY: 500 } })).toEqual([
      { posX: 1000, posY: 500 },
      { posX: 1280, posY: 500 },
    ]);
  });

  it("wraps to the next row at the right edge of the board", () => {
    const [, second] = squashCardPositions([], 2, {
      origin: { posX: 0, posY: 0 },
      canvasWidth: 400,
    });
    expect(second).toEqual({ posX: 0, posY: 160 });
  });

  it("wraps sooner the further right the origin sits", () => {
    // Two columns of room left, so the third card starts the next row.
    const positions = squashCardPositions([], 3, { origin: { posX: CANVAS_W - 600, posY: 0 } });
    expect(positions.map(({ posY }) => posY)).toEqual([0, 0, 160]);
  });

  it("stacks a column when the origin leaves no room for a second one", () => {
    expect(squashCardPositions([], 2, { origin: { posX: CANVAS_W - 100, posY: 0 } })).toEqual([
      { posX: CANVAS_W - 100, posY: 0 },
      { posX: CANVAS_W - 100, posY: 160 },
    ]);
  });
});
