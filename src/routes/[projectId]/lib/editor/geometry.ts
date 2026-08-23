import type { Caret } from "./document-store.svelte.js";

/**
 * How a rendered line is measured. The editor supplies one backed by DOM `Range` rects;
 * tests supply one backed by arithmetic, because jsdom has no layout and every rect it
 * reports is zero.
 */
export type LineMeasurer = {
  /** Pixels from the start of the line to the left edge of `column`. */
  columnToX(line: number, column: number): number;
  /** The column whose cell contains `x`, clamped to the ends of the line. */
  xToColumn(line: number, x: number): number;
};

export type Viewport = {
  scrollTop: number;
  height: number;
  lineHeight: number;
  lineCount: number;
};

/** The band of lines a viewport covers, widened by `overscan` at both ends. */
export function visibleRange(
  { scrollTop, height, lineHeight, lineCount }: Viewport,
  overscan = 4,
): { startLine: number; visibleLineCount: number } {
  const first = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const rows = Math.ceil(height / lineHeight) + overscan * 2;
  return {
    startLine: first,
    visibleLineCount: Math.max(1, Math.min(rows, Math.max(1, lineCount) - first)),
  };
}

/** Where a caret sits, in pixels relative to the top-left of the scrolled content. */
export function caretPoint(
  { line, column }: Caret,
  lineHeight: number,
  measure: LineMeasurer,
): { x: number; y: number } {
  return { x: measure.columnToX(line, column), y: line * lineHeight };
}

/**
 * The point in the document under a pixel, for a click.
 *
 * `y` decides the line by division alone, which is what a fixed line height and no soft
 * wrap buy. `x` is put to the measurer, because the column it lands in cannot be computed
 * from a character width: a document holding CJK has cells of two widths in one line, and
 * one holding a ligature or a combining mark has cells that are not a whole number of
 * either. Guessing here is what makes a click land one character off in Japanese text.
 */
export function pointToCaret(
  x: number,
  y: number,
  lineHeight: number,
  lineCount: number,
  measure: LineMeasurer,
): Caret {
  const line = Math.min(Math.max(0, Math.floor(y / lineHeight)), Math.max(0, lineCount - 1));
  return { line, column: measure.xToColumn(line, Math.max(0, x)) };
}

export type SelectionRect = {
  top: number;
  left: number;
  /** Null means "to the end of the line", which is how a wrapped-through line is drawn. */
  width: number | null;
  height: number;
};

/**
 * A selection as the rectangles that paint it: the tail of the first line, one block for
 * everything between, and the head of the last.
 *
 * Geometry rather than the DOM `Selection` API, which is the trade the render layer is
 * built on. Nothing here asks the browser where the selection is, so nothing here can be
 * moved by the browser deciding differently — and a second range, when there is one, is
 * just another three rectangles.
 */
export function selectionRects(
  start: Caret,
  end: Caret,
  lineHeight: number,
  measure: LineMeasurer,
  lineLength: (line: number) => number,
): SelectionRect[] {
  if (start.line === end.line && start.column === end.column) return [];

  const rects: SelectionRect[] = [];
  const push = (line: number, fromColumn: number, toColumn: number | null): void => {
    const left = measure.columnToX(line, fromColumn);
    rects.push({
      top: line * lineHeight,
      left,
      width: toColumn === null ? null : Math.max(0, measure.columnToX(line, toColumn) - left),
      height: lineHeight,
    });
  };

  if (start.line === end.line) {
    push(start.line, start.column, end.column);
    return rects;
  }

  // The first line runs to its end, and a line selected through its newline is drawn to
  // the edge of the panel rather than stopping at its last character — otherwise a block
  // of selected lines has a ragged right side that does not say the newlines are in it.
  push(start.line, start.column, null);
  for (let line = start.line + 1; line < end.line; line++) push(line, 0, null);
  if (end.column > 0) push(end.line, 0, end.column);
  else if (lineLength(end.line) >= 0) push(end.line, 0, 0);

  return rects;
}

/**
 * A measurer backed by the DOM.
 *
 * `columnToX` measures a `Range` over the line's text up to the column, rather than
 * multiplying a character width, so a proportional font, a CJK cell, and a ligature are all
 * measured as what they are. `xToColumn` binary-searches the same measurement, which costs
 * about `log2(lineLength)` rects — a dozen for a line of four thousand characters.
 *
 * Only ever asked about one line at a time: the one clicked, or the one the caret is on. A
 * hundred-thousand-line document costs no more here than a one-line one.
 */
export function domMeasurer(lineElement: (line: number) => HTMLElement | null): LineMeasurer {
  const textNodeOf = (line: number): { node: Text; length: number } | null => {
    const el = lineElement(line);
    const node = el?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node as Text;
    return { node: text, length: text.length };
  };

  const widthTo = (node: Text, column: number, el: HTMLElement): number => {
    if (column <= 0) return 0;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(column, node.length));
    // Optional-called: jsdom implements Range without the rect methods, and a component
    // test that renders the surface must not die on a measurement it was never going to
    // get a real answer to. Everywhere with layout this is an ordinary call.
    const measured = range.getBoundingClientRect?.();
    const origin = el.getBoundingClientRect?.();
    if (!measured || !origin) return 0;
    // Measured against the line's own left edge so the number is independent of where the
    // panel happens to be scrolled to.
    return measured.right - origin.left;
  };

  return {
    columnToX(line, column) {
      const el = lineElement(line);
      const found = textNodeOf(line);
      if (!el || !found) return 0;
      return widthTo(found.node, column, el);
    },

    xToColumn(line, x) {
      const el = lineElement(line);
      const found = textNodeOf(line);
      if (!el || !found) return 0;
      if (x <= 0) return 0;

      // Binary search for the last column whose left edge is at or before x, then take
      // whichever of that column and the next one the point is nearer to — so clicking the
      // right half of a character puts the caret after it, as every editor does.
      let low = 0;
      let high = found.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (widthTo(found.node, mid, el) <= x) low = mid;
        else high = mid - 1;
      }

      if (low >= found.length) return found.length;
      const here = widthTo(found.node, low, el);
      const next = widthTo(found.node, low + 1, el);
      return x - here > next - x ? low + 1 : low;
    },
  };
}
