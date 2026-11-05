import type { Caret, EditorDocument, VisibleLine } from "./document-store.svelte.js";
import type { domMeasurer } from "./geometry.js";
import { TAB_SIZE, columnAtCell, type WrapLayout } from "./wrap.js";
import type { WrapView } from "./wrap-view.svelte.js";

/** One drawn row of a line. A wrapped line draws one row per wrap. */
export type SurfaceRow = {
  key: string;
  line: number;
  index: number;
  /** Row number in the whole document. */
  row: number;
  /** Column of the line where the row starts. */
  start: number;
  text: string;
};

/** Key of a line's row, shared by the drawn rows and the element cache. */
export function rowKey(line: number, index: number): string {
  return `${line}:${index}`;
}

/**
 * The drawn rows of the drawn lines, limited to `[first, end)`. A long line draws only its
 * rows in view.
 */
export function drawnRows(
  lines: readonly VisibleLine[],
  layout: WrapLayout,
  [first, end]: [number, number],
): SurfaceRow[] {
  const out: SurfaceRow[] = [];
  for (const { lineNumber: line, content } of lines) {
    const starts = layout.rowStarts(line);
    const base = layout.firstRow(line);
    for (let index = 0; index < starts.length; index++) {
      const row = base + index;
      if (row < first || row >= end) continue;
      const start = starts[index];
      const text = content.slice(start, starts[index + 1] ?? content.length);
      out.push({ key: rowKey(line, index), line, index, row, start, text });
    }
  }
  return out;
}

/** Past this many cached rows, entries for rows no longer drawn are dropped. */
const ROW_CACHE_PRUNE_AT = 512;

/**
 * Row elements already found, by row key, for measurement. A keyed row keeps its element
 * while it stays drawn, so a hit that is still in the DOM is current.
 *
 * Rows are found in the DOM rather than kept by an action, because a row that wrapping just
 * created is in the DOM before its action runs, and the measuring effect can run in between.
 */
export class RowElements {
  readonly #root: () => HTMLElement | undefined;
  readonly #cache = new Map<string, HTMLElement>();

  /** @param root Read on use, because the scroll element mounts after this is built. */
  constructor(root: () => HTMLElement | undefined) {
    this.#root = root;
  }

  /** The drawn element of a line's row, or null when the row is not drawn. */
  get(line: number, index: number): HTMLElement | null {
    const key = rowKey(line, index);
    const cached = this.#cache.get(key);
    if (cached?.isConnected) return cached;
    const found =
      this.#root()?.querySelector<HTMLElement>(
        `[data-line="${line}"][data-row-index="${index}"]`,
      ) ?? null;
    if (!found) {
      this.#cache.delete(key);
      return null;
    }
    // Rows scrolled away leave stale entries behind. Drop those, and keep the rows still drawn
    // so the next measurements find them without searching again.
    if (this.#cache.size >= ROW_CACHE_PRUNE_AT) {
      for (const [k, el] of this.#cache) if (!el.isConnected) this.#cache.delete(k);
    }
    this.#cache.set(key, found);
    return found;
  }
}

/** What the caret measurements below read from the surface. */
export type SurfaceMeasures = {
  doc: EditorDocument;
  layout: WrapLayout;
  wrap: Pick<WrapView, "wraps" | "cellsAt">;
  measure: ReturnType<typeof domMeasurer>;
  rowElement: (line: number, index: number) => HTMLElement | null;
};

/**
 * The caret `by` rows above or below `caret`, as near `x` as the target row allows. A row
 * out of view cannot be measured, so count cells to `x` instead, or, before the font is
 * measured, aim for `offset` columns into the row.
 */
export function caretRowsAway(
  { doc, layout, wrap, measure, rowElement }: SurfaceMeasures,
  caret: Caret,
  by: number,
  x: number,
  offset: number,
): Caret {
  const here = layout.rowOf(caret.line, caret.column);
  const { line, index } = layout.rowAt(here + by);
  if (wrap.wraps && rowElement(line, index))
    return { line, column: measure.xToColumn(line, x, index) };
  const start = layout.rowStarts(line)[index];
  const end = layout.rowEnd(line, index);
  let column: number;
  if (wrap.wraps) {
    const lineText = doc.lineText(line);
    column = columnAtCell(lineText, start, end ?? lineText.length, wrap.cellsAt(x), TAB_SIZE);
  } else {
    column = start + offset;
  }
  // A wrapped row's last column is drawn on the next row, so stop before it. Clamping snaps
  // back to the start of the character.
  return { line, column: end === null ? column : Math.min(column, end - 1) };
}

/**
 * The drawn caret's width: a bar in insert mode, and in normal mode a block as wide as the
 * character under it. A block at a line's end, or on a row's last character before a wrap,
 * cannot measure up to the next column, so it takes a typical character's width.
 */
export function caretWidth(
  { doc, layout, measure }: Pick<SurfaceMeasures, "doc" | "layout" | "measure">,
  caret: Caret,
  mode: "insert" | "normal",
  fontSize: number,
): number {
  if (mode !== "normal") return 2;
  const lineText = doc.lineText(caret.line);
  const after = doc.columnAfter(caret.line, caret.column);
  const rowEnds = layout.rowIndex(caret.line, after) !== layout.rowIndex(caret.line, caret.column);
  if (caret.column >= lineText.length || rowEnds) return fontSize * 0.6;
  return Math.max(
    2,
    measure.columnToX(caret.line, after) - measure.columnToX(caret.line, caret.column),
  );
}
