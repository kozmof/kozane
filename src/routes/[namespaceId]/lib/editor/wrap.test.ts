import { describe, it, expect } from "vitest";
import { cellWidth, columnAtCell, LineWrapper, wrapLine, WrapLayout } from "./wrap.js";

/** Rows of `text` as strings, which reads more plainly than row starts. */
function rows(text: string, cols: number, tabSize?: number): string[] {
  const starts = wrapLine(text, cols, tabSize);
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length));
}

describe("cellWidth", () => {
  it("counts ASCII as one cell", () => {
    expect(cellWidth("a")).toBe(1);
  });

  it("counts CJK, Hangul, fullwidth forms, and emoji as two cells", () => {
    for (const wide of ["あ", "漢", "한", "Ａ", "😀", "👩🏽‍💻"]) expect(cellWidth(wide)).toBe(2);
  });

  it("counts a keycap emoji led by an ASCII digit as two cells", () => {
    expect(cellWidth("1\ufe0f\u20e3")).toBe(2);
  });

  it("counts a letter with a combining mark as one cell", () => {
    expect(cellWidth("é")).toBe(1);
  });

  it("counts zero-width characters as no cells", () => {
    expect(cellWidth("​")).toBe(0);
  });
});

describe("wrapLine", () => {
  it("keeps a line that fits on one row", () => {
    expect(rows("hello world", 11)).toEqual(["hello world"]);
  });

  it("breaks after the last space that fits", () => {
    expect(rows("hello brave new world", 12)).toEqual(["hello brave ", "new world"]);
  });

  it("breaks inside a word wider than a row", () => {
    expect(rows("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("breaks a long word that follows a space onto rows of its own", () => {
    expect(rows("ab abcdefghij", 4)).toEqual(["ab ", "abcd", "efgh", "ij"]);
  });

  it("counts wide characters as two cells", () => {
    expect(rows("あいうえお", 4)).toEqual(["あい", "うえ", "お"]);
  });

  it("never splits a grapheme cluster", () => {
    const text = "ab👩🏽‍💻cd";
    expect(rows(text, 3)).toEqual(["ab", "👩🏽‍💻c", "d"]);
  });

  it("advances tabs to the next tab stop", () => {
    expect(rows("a\tb\tc", 8, 4)).toEqual(["a\tb\t", "c"]);
  });

  it("does not wrap without a usable width", () => {
    const long = "word ".repeat(100);
    expect(wrapLine(long, Infinity)).toEqual([0]);
    expect(wrapLine(long, 0)).toEqual([0]);
  });

  it("puts at least one character on every row", () => {
    expect(rows("あい", 1)).toEqual(["あ", "い"]);
  });
});

describe("columnAtCell", () => {
  it("finds the column nearest a cell count within a row", () => {
    expect(columnAtCell("aaaa bbbb cccc", 5, 14, 2)).toBe(7);
  });

  it("counts wide characters as two cells", () => {
    expect(columnAtCell("あいうえ", 0, 4, 4)).toBe(2);
    expect(columnAtCell("あいうえ", 0, 4, 3.4)).toBe(2);
    expect(columnAtCell("あいうえ", 0, 4, 2.6)).toBe(1);
  });

  it("advances tabs to the next stop", () => {
    expect(columnAtCell("\tab", 0, 3, 9, 8)).toBe(2);
  });

  it("stops at the row's end when the count runs past it", () => {
    expect(columnAtCell("aaaa bbbb", 0, 5, 40)).toBe(5);
  });
});

describe("WrapLayout", () => {
  // Line 0 has three rows, line 1 one, line 2 two.
  const layout = WrapLayout.of([[0, 4, 8], [0], [0, 3]]);

  it("counts every row", () => {
    expect(layout.rowCount).toBe(6);
    expect(layout.lineCount).toBe(3);
  });

  it("numbers each line's first row after the rows before it", () => {
    expect([0, 1, 2].map((line) => layout.firstRow(line))).toEqual([0, 3, 4]);
  });

  it("finds the line and row index drawn at a row", () => {
    expect(layout.rowAt(0)).toEqual({ line: 0, index: 0 });
    expect(layout.rowAt(2)).toEqual({ line: 0, index: 2 });
    expect(layout.rowAt(3)).toEqual({ line: 1, index: 0 });
    expect(layout.rowAt(5)).toEqual({ line: 2, index: 1 });
  });

  it("clamps rows outside the document", () => {
    expect(layout.rowAt(-3)).toEqual({ line: 0, index: 0 });
    expect(layout.rowAt(99)).toEqual({ line: 2, index: 1 });
  });

  it("draws a column at a wrap point at the start of the next row", () => {
    expect(layout.rowIndex(0, 3)).toBe(0);
    expect(layout.rowIndex(0, 4)).toBe(1);
    expect(layout.rowOf(0, 9)).toBe(2);
    expect(layout.rowOf(2, 3)).toBe(5);
  });

  it("reports where each row ends", () => {
    expect(layout.rowEnd(0, 0)).toBe(4);
    expect(layout.rowEnd(0, 2)).toBeNull();
  });

  it("maps rows to lines one to one when unwrapped", () => {
    const flat = WrapLayout.unwrapped(5);
    expect(flat.rowCount).toBe(5);
    expect(flat.rowAt(3)).toEqual({ line: 3, index: 0 });
    expect(flat.rowOf(3, 100)).toBe(3);
  });

  it("has one row for an empty document", () => {
    expect(WrapLayout.unwrapped(0).rowCount).toBe(1);
  });
});

describe("LineWrapper", () => {
  it("splits lines at every break Reed recognizes", () => {
    const layout = new LineWrapper(80).layout("a\r\nb\rc\nd");
    expect(layout.lineCount).toBe(4);
  });

  it("counts the empty line after a trailing newline", () => {
    expect(new LineWrapper(80).layout("x\n").lineCount).toBe(2);
  });

  it("lays out each line at its width", () => {
    const layout = new LineWrapper(6).layout("short\nhello brave world");
    expect(layout.rowStarts(0)).toEqual([0]);
    expect(layout.rowStarts(1)).toEqual([0, 6, 12]);
  });

  it("does not wrap at an infinite width", () => {
    const wrapper = new LineWrapper(Infinity);
    expect(wrapper.wraps).toBe(false);
    expect(wrapper.layout("word ".repeat(100)).rowCount).toBe(1);
  });

  it("reuses the rows of lines an edit left alone, and only those", () => {
    const wrapper = new LineWrapper(6);
    const first = wrapper.layout("hello brave world\nsecond long line");
    const second = wrapper.layout("hello brave world\nsecond long line!");
    expect(second.rowStarts(0)).toBe(first.rowStarts(0));
    expect(second.rowStarts(1)).not.toBe(first.rowStarts(1));
    // A line dropped by the last layout is laid out afresh rather than kept.
    const third = wrapper.layout("second long line");
    expect(third.rowStarts(0)).not.toBe(first.rowStarts(1));
    expect(third.rowStarts(0)).toEqual(first.rowStarts(1));
  });
});
