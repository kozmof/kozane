import type { Caret } from "./document-store.svelte.js";

/**
 * Rendered line measurement interface. Production uses DOM Range rectangles, while tests
 * provide fixed geometry.
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
 * Resolve a click to a document position. Fixed line height determines the line. Measure
 * horizontal position to handle CJK, ligatures, and combining marks accurately.
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
 * Compute selection rectangles for the first-line tail, full middle lines, and last-line
 * head. Keep drawing independent of browser Selection state.
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

  // Extend a selection through a newline to the panel edge so the highlight shows that the
  // newline is included.
  push(start.line, start.column, null);
  for (let line = start.line + 1; line < end.line; line++) push(line, 0, null);
  if (end.column > 0) push(end.line, 0, end.column);
  else if (lineLength(end.line) >= 0) push(end.line, 0, 0);

  return rects;
}

/**
 * Measure text with DOM Ranges so proportional fonts, CJK characters, and ligatures use
 * actual layout. Binary-search those measurements to map x coordinates to columns. Each query
 * measures one line.
 */
export function domMeasurer(lineElement: (line: number) => HTMLElement | null): LineMeasurer {
  const textNodeOf = (line: number): { node: Text; length: number } | null => {
    const el = lineElement(line);
    const node = el?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node as Text;
    return { node: text, length: text.length };
  };

  /**
   * Measure pixels from the text start to `column` using range width. This excludes element
   * padding and naturally returns zero at column 0.
   */
  const widthTo = (node: Text, column: number): number => {
    if (column <= 0) return 0;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(column, node.length));
    // Allow missing Range rectangle methods in jsdom, where real layout measurements are
    // unavailable.
    return range.getBoundingClientRect?.()?.width ?? 0;
  };

  return {
    columnToX(line, column) {
      const found = textNodeOf(line);
      if (!found) return 0;
      return widthTo(found.node, column);
    },

    xToColumn(line, x) {
      const found = textNodeOf(line);
      if (!found) return 0;
      if (x <= 0) return 0;

      // Find the last column edge at or before x, then choose the nearer of that edge and the
      // next.
      let low = 0;
      let high = found.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (widthTo(found.node, mid) <= x) low = mid;
        else high = mid - 1;
      }

      if (low >= found.length) return found.length;
      const here = widthTo(found.node, low);
      const next = widthTo(found.node, low + 1);
      return x - here > next - x ? low + 1 : low;
    },
  };
}
