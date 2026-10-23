import type { EditorDocument } from "./document-store.svelte.js";
import { LineWrapper, TAB_SIZE, WrapLayout } from "./wrap.js";

/**
 * Wrapping for one editor surface. The surface measures the font's cell width and its own
 * width into this, and reads back the rows they lay the document out in. Kept apart from the
 * surface so the layout can be tested without the DOM.
 */
export class WrapView {
  /** Pixels one cell of the font takes, or 0 before it is measured. */
  cellWidth = $state(0);
  /** Width of the panel in pixels, padding included, or 0 before it is measured. */
  viewportWidth = $state(0);

  /** Cells that fit on a row, or Infinity before the panel and font are measured. */
  cols: number;
  /** The rows the document is laid out in. One per line until wrapping is measured. */
  layout: WrapLayout;

  #wrapper: LineWrapper;
  #warned = false;

  /**
   * @param padding Pixels of the panel width that text does not use.
   * @param minCols Narrowest row allowed, so a squeezed panel still shows whole words.
   */
  constructor(
    doc: () => EditorDocument,
    {
      padding = 0,
      minCols = 1,
      tabSize = TAB_SIZE,
    }: {
      padding?: number;
      minCols?: number;
      tabSize?: number;
    } = {},
  ) {
    this.cols = $derived(
      this.cellWidth > 0 && this.viewportWidth > 0
        ? Math.max(minCols, Math.floor((this.viewportWidth - padding) / this.cellWidth))
        : Infinity,
    );
    this.#wrapper = $derived(new LineWrapper(this.cols, tabSize));
    // A string, so Reed's background reconciliation, which replaces the state without an
    // edit, does not lay the document out again.
    const text = $derived(this.#wrapper.wraps ? doc().text() : "");
    this.layout = $derived.by(() => {
      const lineCount = doc().lineCount;
      if (!this.#wrapper.wraps) return WrapLayout.unwrapped(lineCount);
      const wrapped = this.#wrapper.layout(text);
      // Lines are split the way Reed splits them. Should they ever disagree, draw unwrapped
      // rather than put the caret on the wrong line, and say so once, since nothing on
      // screen would.
      if (wrapped.lineCount === Math.max(1, lineCount)) return wrapped;
      if (!this.#warned) {
        this.#warned = true;
        console.warn(
          `[kozane] Editor wrapping is off: the text splits into ${wrapped.lineCount} lines, but the document has ${lineCount}.`,
        );
      }
      return WrapLayout.unwrapped(lineCount);
    });
  }

  /** Whether lines wrap at all, which needs both widths measured. */
  get wraps(): boolean {
    return this.#wrapper.wraps;
  }

  /** Cells from a row's start to `x` pixels into it. */
  cellsAt(x: number): number {
    return this.cellWidth > 0 ? x / this.cellWidth : 0;
  }
}
