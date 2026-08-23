import { describe, it, expect, afterEach } from "vitest";
import {
  caretPoint,
  domMeasurer,
  type LineMeasurer,
  pointToCaret,
  selectionRects,
  visibleRange,
} from "./geometry.js";

/**
 * A measurer for a monospace font of a known cell width, with CJK counted double. Stands in
 * for the DOM one, which cannot be exercised in jsdom: there is no layout there, so every
 * rect comes back zero.
 */
function fixedMeasurer(lines: string[], cell = 10): LineMeasurer {
  const widthTo = (line: number, column: number): number => {
    const text = lines[line] ?? "";
    let x = 0;
    for (const ch of [...text].slice(0, column)) x += /[　-鿿]/.test(ch) ? cell * 2 : cell;
    return x;
  };
  return {
    columnToX: widthTo,
    xToColumn(line, x) {
      const text = lines[line] ?? "";
      for (let column = 0; column <= text.length; column++) {
        const here = widthTo(line, column);
        const next = widthTo(line, column + 1);
        if (column === text.length) return column;
        if (x < (here + next) / 2) return column;
      }
      return text.length;
    },
  };
}

describe("visibleRange", () => {
  it("covers the viewport plus the overscan at both ends", () => {
    const range = visibleRange({ scrollTop: 200, height: 100, lineHeight: 20, lineCount: 1000 }, 4);
    expect(range.startLine).toBe(6); // line 10, less 4 of overscan
    expect(range.visibleLineCount).toBe(13); // 5 rows, plus 4 above and 4 below
  });

  it("does not start above the first line", () => {
    const range = visibleRange({ scrollTop: 0, height: 100, lineHeight: 20, lineCount: 1000 }, 4);
    expect(range.startLine).toBe(0);
  });

  it("does not run past the last line", () => {
    const range = visibleRange({ scrollTop: 0, height: 1000, lineHeight: 20, lineCount: 7 }, 0);
    expect(range.startLine).toBe(0);
    expect(range.visibleLineCount).toBe(7);
  });

  it("asks for at least one line in an empty document", () => {
    const range = visibleRange({ scrollTop: 0, height: 100, lineHeight: 20, lineCount: 0 }, 0);
    expect(range.visibleLineCount).toBe(1);
  });
});

describe("caretPoint", () => {
  it("puts the caret at the line's top and the column's left edge", () => {
    const measure = fixedMeasurer(["hello"]);
    expect(caretPoint({ line: 0, column: 3 }, 20, measure)).toEqual({ x: 30, y: 0 });
    expect(caretPoint({ line: 2, column: 0 }, 20, measure)).toEqual({ x: 0, y: 40 });
  });

  it("measures a CJK cell as what it is rather than as one character width", () => {
    const measure = fixedMeasurer(["あa"]);
    expect(caretPoint({ line: 0, column: 1 }, 20, measure).x).toBe(20);
    expect(caretPoint({ line: 0, column: 2 }, 20, measure).x).toBe(30);
  });
});

describe("pointToCaret", () => {
  const measure = fixedMeasurer(["hello", "あい", ""]);

  it("divides y by the line height to find the line", () => {
    expect(pointToCaret(0, 25, 20, 3, measure).line).toBe(1);
  });

  it("clamps to the last line below the end of the document", () => {
    expect(pointToCaret(0, 9999, 20, 3, measure).line).toBe(2);
  });

  it("clamps to the first line above the start", () => {
    expect(pointToCaret(0, -50, 20, 3, measure).line).toBe(0);
  });

  it("puts the caret after a character clicked on its right half", () => {
    expect(pointToCaret(4, 0, 20, 3, measure).column).toBe(0);
    expect(pointToCaret(6, 0, 20, 3, measure).column).toBe(1);
  });

  it("lands on the right column in a line of double-width cells", () => {
    // "あい" — cells at 0-20 and 20-40.
    expect(pointToCaret(5, 25, 20, 3, measure).column).toBe(0);
    expect(pointToCaret(25, 25, 20, 3, measure).column).toBe(1);
    expect(pointToCaret(38, 25, 20, 3, measure).column).toBe(2);
  });

  it("clamps past the end of a line to its last column", () => {
    expect(pointToCaret(9999, 0, 20, 3, measure).column).toBe(5);
  });
});

describe("selectionRects", () => {
  const lines = ["hello", "world", "again", "here"];
  const measure = fixedMeasurer(lines);
  const lineLength = (line: number) => (lines[line] ?? "").length;

  it("draws nothing for an empty selection", () => {
    expect(
      selectionRects({ line: 1, column: 2 }, { line: 1, column: 2 }, 20, measure, lineLength),
    ).toEqual([]);
  });

  it("draws one rectangle for a selection inside a single line", () => {
    const rects = selectionRects(
      { line: 1, column: 1 },
      { line: 1, column: 4 },
      20,
      measure,
      lineLength,
    );
    expect(rects).toEqual([{ top: 20, left: 10, width: 30, height: 20 }]);
  });

  it("draws first, middle, and last rectangles across lines", () => {
    const rects = selectionRects(
      { line: 0, column: 2 },
      { line: 2, column: 3 },
      20,
      measure,
      lineLength,
    );
    expect(rects).toEqual([
      { top: 0, left: 20, width: null, height: 20 },
      { top: 20, left: 0, width: null, height: 20 },
      { top: 40, left: 0, width: 30, height: 20 },
    ]);
  });

  it("runs a line selected through its newline to the edge rather than to its last character", () => {
    const rects = selectionRects(
      { line: 0, column: 0 },
      { line: 1, column: 0 },
      20,
      measure,
      lineLength,
    );
    expect(rects[0].width).toBeNull();
  });

  it("orders the rectangles down the document regardless of the columns", () => {
    const rects = selectionRects(
      { line: 0, column: 4 },
      { line: 1, column: 1 },
      20,
      measure,
      lineLength,
    );
    expect(rects.map(({ top }) => top)).toEqual([0, 20]);
  });
});

/**
 * The DOM measurer, driven against a stubbed layout.
 *
 * jsdom reports every rect as zero and implements `Range` without the rect methods at all,
 * so the two are stubbed here to give each character a known width. What is under test is
 * the search over those measurements — the part that decides which column a click lands in
 * — rather than the browser's text metrics.
 */
describe("domMeasurer", () => {
  const CELL = 8;

  function stubLayout(text: string) {
    // Each character is CELL wide, except a CJK one, which is two cells.
    const el = document.createElement("div");
    el.textContent = text;
    document.body.append(el);

    const widthOf = (upto: number): number => {
      let x = 0;
      for (const ch of [...text].slice(0, upto)) x += /[　-鿿]/.test(ch) ? CELL * 2 : CELL;
      return x;
    };

    el.getBoundingClientRect = () => ({ left: 100, right: 100 + widthOf(text.length) }) as DOMRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
      return { left: 100, right: 100 + widthOf(this.endOffset) } as DOMRect;
    };

    return { el, widthOf };
  }

  afterEach(() => {
    document.body.innerHTML = "";
    // @ts-expect-error — removing the stub so it cannot leak into another file's run.
    delete Range.prototype.getBoundingClientRect;
  });

  it("measures a column against the line's own left edge", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.columnToX(0, 0)).toBe(0);
    expect(measure.columnToX(0, 3)).toBe(CELL * 3);
    expect(measure.columnToX(0, 5)).toBe(CELL * 5);
  });

  it("finds the column a point falls in", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.xToColumn(0, 0)).toBe(0);
    expect(measure.xToColumn(0, CELL * 3)).toBe(3);
  });

  it("puts the caret after a character clicked on its right half", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.xToColumn(0, CELL * 2 + 1)).toBe(2);
    expect(measure.xToColumn(0, CELL * 3 - 1)).toBe(3);
  });

  it("clamps past either end of the line", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.xToColumn(0, -50)).toBe(0);
    expect(measure.xToColumn(0, 9999)).toBe(5);
  });

  it("lands on the right column in a line of double-width cells", () => {
    const { el } = stubLayout("あいう");
    const measure = domMeasurer(() => el);
    expect(measure.columnToX(0, 1)).toBe(CELL * 2);
    expect(measure.xToColumn(0, CELL * 2 + 1)).toBe(1);
    expect(measure.xToColumn(0, CELL * 4 + 1)).toBe(2);
  });

  it("answers zero for a line that is not in the DOM", () => {
    const measure = domMeasurer(() => null);
    expect(measure.columnToX(0, 4)).toBe(0);
    expect(measure.xToColumn(0, 40)).toBe(0);
  });

  it("answers zero for an empty line, which has no text node to measure", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const measure = domMeasurer(() => el);
    expect(measure.columnToX(0, 0)).toBe(0);
    expect(measure.xToColumn(0, 40)).toBe(0);
  });
});
