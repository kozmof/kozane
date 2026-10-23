import type { Caret } from "./document-store.svelte.js";
import { WrapLayout } from "./wrap.js";

/**
 * Rendered line measurement interface. Production uses DOM Range rectangles, while tests
 * provide fixed geometry.
 */
export type LineMeasurer = {
  /** Pixels from the start of the row drawing `column` to its left edge. */
  columnToX(line: number, column: number): number;
  /**
   * Column boundary nearest to `x` on the line's row `index`, clamped to that row. Rows
   * other than the last stop before their final character, so a click past a wrapped row's
   * end leaves the caret on that row.
   */
  xToColumn(line: number, x: number, index?: number): number;
};

export type Viewport = {
  scrollTop: number;
  height: number;
  lineHeight: number;
  /** Rows to scroll through, which are lines when nothing wraps. */
  rowCount: number;
};

/** The band of rows a viewport covers, widened by `overscan` at both ends. */
export function visibleRange(
  { scrollTop, height, lineHeight, rowCount }: Viewport,
  overscan = 4,
): { startRow: number; visibleRowCount: number } {
  const first = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const rows = Math.ceil(height / lineHeight) + overscan * 2;
  return {
    startRow: first,
    visibleRowCount: Math.max(1, Math.min(rows, Math.max(1, rowCount) - first)),
  };
}

/** Where a caret sits, in pixels relative to the top-left of the scrolled content. */
export function caretPoint(
  { line, column }: Caret,
  lineHeight: number,
  measure: LineMeasurer,
  layout?: WrapLayout,
): { x: number; y: number } {
  const row = layout ? layout.rowOf(line, column) : line;
  return { x: measure.columnToX(line, column), y: row * lineHeight };
}

/**
 * Resolve a click to a document position. Fixed row height determines the row. Measure
 * horizontal position to handle CJK, ligatures, and combining marks accurately.
 */
export function pointToCaret(
  x: number,
  y: number,
  lineHeight: number,
  lineCount: number,
  measure: LineMeasurer,
  layout: WrapLayout = WrapLayout.unwrapped(lineCount),
): Caret {
  const { line, index } = layout.rowAt(Math.floor(y / lineHeight));
  return { line, column: measure.xToColumn(line, Math.max(0, x), index) };
}

export type SelectionRect = {
  top: number;
  left: number;
  /** Null means "to the end of the line", which is how a wrapped-through line is drawn. */
  width: number | null;
  height: number;
};

/** What {@link selectionRects} needs to know about how the document is drawn. */
export type SelectionGeometry = {
  lineHeight: number;
  measure: LineMeasurer;
  lineLength: (line: number) => number;
  /** Lines in the DOM. When given, rectangles are drawn for these lines only. */
  mountedLines?: readonly number[];
  /** Visual rows. Needs `mountedLines`, and draws one rectangle per selected row. */
  layout?: WrapLayout;
  /** Rows drawn, as `[first, end)`, so one very long line cannot draw rows off screen. */
  shownRows?: readonly [number, number];
};

/**
 * Compute selection rectangles for the first-line tail, full middle lines, and last-line
 * head. Keep drawing independent of browser Selection state.
 */
export function selectionRects(
  start: Caret,
  end: Caret,
  { lineHeight, measure, lineLength, mountedLines, layout, shownRows }: SelectionGeometry,
): SelectionRect[] {
  if (start.line === end.line && start.column === end.column) return [];

  const rects: SelectionRect[] = [];
  const push = (line: number, fromColumn: number, toColumn: number | null): void => {
    const left = measure.columnToX(line, fromColumn);
    rects.push({
      top: (layout ? layout.rowOf(line, fromColumn) : line) * lineHeight,
      left,
      width: toColumn === null ? null : Math.max(0, measure.columnToX(line, toColumn) - left),
      height: lineHeight,
    });
  };

  if (mountedLines && layout) {
    const [first, last] = shownRows ?? [0, layout.rowCount];
    for (const line of mountedLines) {
      if (line < start.line || line > end.line) continue;
      const starts = layout.rowStarts(line);
      const base = layout.firstRow(line);
      for (let index = 0; index < starts.length; index++) {
        if (base + index < first || base + index >= last) continue;
        const rowStart = starts[index];
        const rowEnd = layout.rowEnd(line, index);
        // A selection starting at a wrap point starts on the next row.
        if (line === start.line && rowEnd !== null && start.column >= rowEnd) continue;
        // A selection ending at a wrap point covers none of the row it starts.
        if (line === end.line && index > 0 && end.column <= rowStart) continue;
        const from = line === start.line ? Math.max(start.column, rowStart) : rowStart;
        // Run to the panel edge when the selection continues past this row, onto the next
        // row of the line or through its newline.
        const through = line < end.line || (rowEnd !== null && end.column >= rowEnd);
        if (through) {
          rects.push({
            top: (base + index) * lineHeight,
            left: measure.columnToX(line, from),
            width: null,
            height: lineHeight,
          });
        } else push(line, from, end.column);
      }
    }
    return rects;
  }

  // Keep selection overlays bounded by the viewport, including select-all.
  if (mountedLines) {
    for (const line of mountedLines) {
      if (line < start.line || line > end.line) continue;
      push(line, line === start.line ? start.column : 0, line === end.line ? end.column : null);
    }
    return rects;
  }

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
export function domMeasurer(
  rowElement: (line: number, index: number) => HTMLElement | null,
  layout: () => WrapLayout | undefined = () => undefined,
): LineMeasurer {
  const textNodeOf = (line: number, index = 0): { node: Text; length: number } | null => {
    const el = rowElement(line, index);
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
      const rows = layout();
      const index = rows ? rows.rowIndex(line, column) : 0;
      const start = rows ? rows.rowStarts(line)[index] : 0;
      const found = textNodeOf(line, index);
      if (!found) return 0;
      return widthTo(found.node, column - start);
    },

    xToColumn(line, x, index = 0) {
      const rows = layout();
      const start = rows ? (rows.rowStarts(line)[index] ?? 0) : 0;
      const wrapped = rows ? rows.rowEnd(line, index) !== null : false;
      const found = textNodeOf(line, index);
      if (!found) return start;
      return start + nearestColumn(found, x, wrapped);
    },
  };

  /**
   * Column in `found` nearest to `x`. On a wrapped row, stop before the last character,
   * because the column after it is drawn at the start of the next row.
   */
  function nearestColumn(found: { node: Text; length: number }, x: number, wrapped: boolean) {
    const limit = wrapped ? Math.max(0, found.length - 1) : found.length;
    return Math.min(limit, columnAtX(found, x));
  }

  function columnAtX(found: { node: Text; length: number }, x: number): number {
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
  }
}
