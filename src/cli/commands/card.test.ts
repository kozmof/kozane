import { describe, expect, it } from "vitest";
import { splitCardContent, squashCardPositions } from "./card";

describe("card squash", () => {
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
