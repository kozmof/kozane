import { describe, it, expect, afterEach } from "vitest";
import {
  caretPoint,
  domMeasurer,
  type LineMeasurer,
  pointToCaret,
  selectionRects,
  visibleRange,
} from "./geometry.js";
import { WrapLayout } from "./wrap.js";

/**
 * Monospace measurement stub with double-width CJK cells. jsdom has no layout and cannot
 * supply real DOM measurements.
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
    // The two characters occupy horizontal ranges 0–20 and 20–40.
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

  it("clips a million-line selection to the mounted viewport", () => {
    const rects = selectionRects(
      { line: 0, column: 2 },
      { line: 999999, column: 3 },
      20,
      measure,
      lineLength,
      [500000, 500001, 500002],
    );
    expect(rects).toEqual(
      [500000, 500001, 500002].map((line) => ({
        top: line * 20,
        left: 0,
        width: null,
        height: 20,
      })),
    );
  });

  it("clips selection endpoints without highlighting unselected mounted lines", () => {
    expect(
      selectionRects(
        { line: 1, column: 2 },
        { line: 2, column: 3 },
        20,
        measure,
        lineLength,
        [0, 1, 2, 3],
      ),
    ).toEqual([
      { top: 20, left: 20, width: null, height: 20 },
      { top: 40, left: 0, width: 30, height: 20 },
    ]);
    expect(
      selectionRects({ line: 0, column: 0 }, { line: 3, column: 0 }, 20, measure, lineLength, []),
    ).toEqual([]);
  });

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
 * Line 0, "hello brave world", wraps into "hello ", "brave ", and "world". Line 1, "again",
 * fits. Each cell is 10 pixels, measured from the start of the row drawing the column.
 */
describe("wrapped rows", () => {
  const lines = ["hello brave world", "again"];
  const layout = WrapLayout.of([[0, 6, 12], [0]]);
  const rowStart = (line: number, column: number) =>
    layout.rowStarts(line)[layout.rowIndex(line, column)];
  const measure: LineMeasurer = {
    columnToX: (line, column) => (column - rowStart(line, column)) * 10,
    xToColumn: (line, x, index = 0) => layout.rowStarts(line)[index] + Math.round(x / 10),
  };
  const lineLength = (line: number) => (lines[line] ?? "").length;
  const select = (start: [number, number], end: [number, number], shown?: [number, number]) =>
    selectionRects(
      { line: start[0], column: start[1] },
      { line: end[0], column: end[1] },
      20,
      measure,
      lineLength,
      [0, 1],
      layout,
      shown,
    );

  it("puts the caret on the row drawing its column", () => {
    expect(caretPoint({ line: 0, column: 3 }, 20, measure, layout)).toEqual({ x: 30, y: 0 });
    expect(caretPoint({ line: 0, column: 8 }, 20, measure, layout)).toEqual({ x: 20, y: 20 });
    expect(caretPoint({ line: 1, column: 2 }, 20, measure, layout)).toEqual({ x: 20, y: 60 });
  });

  it("draws a caret at a wrap point at the start of the next row", () => {
    expect(caretPoint({ line: 0, column: 6 }, 20, measure, layout)).toEqual({ x: 0, y: 20 });
  });

  it("resolves a click to the row under it", () => {
    expect(pointToCaret(20, 25, 20, 2, measure, layout)).toEqual({ line: 0, column: 8 });
    expect(pointToCaret(0, 45, 20, 2, measure, layout)).toEqual({ line: 0, column: 12 });
    expect(pointToCaret(10, 65, 20, 2, measure, layout)).toEqual({ line: 1, column: 1 });
  });

  it("runs a selection to the edge on rows it continues past", () => {
    expect(select([0, 2], [0, 8])).toEqual([
      { top: 0, left: 20, width: null, height: 20 },
      { top: 20, left: 0, width: 20, height: 20 },
    ]);
  });

  it("starts a selection at a wrap point on the next row", () => {
    expect(select([0, 6], [1, 2])).toEqual([
      { top: 20, left: 0, width: null, height: 20 },
      { top: 40, left: 0, width: null, height: 20 },
      { top: 60, left: 0, width: 20, height: 20 },
    ]);
  });

  it("draws nothing on the row a selection ends at the start of", () => {
    expect(select([0, 0], [0, 6]).map(({ top }) => top)).toEqual([0]);
  });

  it("draws only the rows shown", () => {
    expect(select([0, 0], [1, 5], [1, 3]).map(({ top }) => top)).toEqual([20, 40]);
  });
});

/**
 * Stub element and Range rectangles in jsdom to test column lookup over known character
 * measurements.
 */
describe("domMeasurer", () => {
  const CELL = 8;

  /**
   * Model `padding-left` with `PAD` so the element edge differs from the first character's
   * position. Column measurements must use the text origin to avoid a padding-sized offset.
   */
  const PAD = 12;

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

    // The element begins at 100 and its padded text begins at `100 + PAD`.
    el.getBoundingClientRect = () =>
      ({ left: 100, right: 100 + PAD + widthOf(text.length) }) as DOMRect;
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const left = 100 + PAD + widthOf(this.startOffset);
      const right = 100 + PAD + widthOf(this.endOffset);
      return { left, right, width: right - left } as DOMRect;
    };

    return { el, widthOf };
  }

  afterEach(() => {
    document.body.innerHTML = "";
    // @ts-expect-error Remove the stub so it cannot affect another test file.
    delete Range.prototype.getBoundingClientRect;
  });

  it("measures a column from the start of the text, not from the element", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    // Return text-relative measurements without line padding. The caller adds padding when
    // drawing.
    expect(measure.columnToX(0, 0)).toBe(0);
    expect(measure.columnToX(0, 3)).toBe(CELL * 3);
    expect(measure.columnToX(0, 5)).toBe(CELL * 5);
  });

  it("keeps column 0 continuous with every other column", () => {
    // Use the same text origin for every column so the first character has the same measured
    // width as the others and clicks at the line start reach column 0.
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.columnToX(0, 1) - measure.columnToX(0, 0)).toBe(CELL);
    expect(measure.columnToX(0, 2) - measure.columnToX(0, 1)).toBe(CELL);
  });

  it("puts a click at the very start of the text on column 0", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.xToColumn(0, 0)).toBe(0);
    expect(measure.xToColumn(0, 1)).toBe(0);
  });

  it("round-trips a column through x and back", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    for (const column of [0, 1, 2, 3, 4, 5]) {
      expect(measure.xToColumn(0, measure.columnToX(0, column))).toBe(column);
    }
  });

  it("puts a click at the end of the text on the last column, not past it", () => {
    const { el } = stubLayout("hello");
    const measure = domMeasurer(() => el);
    expect(measure.xToColumn(0, CELL * 5)).toBe(5);
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

  it("measures a wrapped line within the row drawing the column", () => {
    stubLayout("hello brave world");
    const els = ["hello ", "brave ", "world"].map((text) => {
      const el = document.createElement("div");
      el.textContent = text;
      document.body.append(el);
      return el;
    });
    const layout = WrapLayout.of([[0, 6, 12]]);
    const measure = domMeasurer(
      (_line, index) => els[index] ?? null,
      () => layout,
    );

    expect(measure.columnToX(0, 8)).toBe(CELL * 2);
    expect(measure.columnToX(0, 6)).toBe(0);
    expect(measure.xToColumn(0, CELL, 1)).toBe(7);
    // Past the end of a wrapped row, stay on it rather than jump to the next row.
    expect(measure.xToColumn(0, 9999, 0)).toBe(5);
    expect(measure.xToColumn(0, 9999, 2)).toBe(17);
  });

  it("answers zero for an empty line, which has no text node to measure", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const measure = domMeasurer(() => el);
    expect(measure.columnToX(0, 0)).toBe(0);
    expect(measure.xToColumn(0, 40)).toBe(0);
  });
});
