import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorDocument } from "./document-store.svelte.js";
import { WrapView } from "./wrap-view.svelte.js";
import { LineWrapper } from "./wrap.js";

/**
 * A view over `text` with 24 pixels of padding and a 10-cell minimum. By default the font has
 * ten-pixel cells and the panel is 224 pixels wide, which fits 20 cells.
 */
function view(text: string, { cellWidth = 10, viewportWidth = 224 } = {}) {
  const doc = new EditorDocument(text);
  const wrap = new WrapView(() => doc, { padding: 24, minCols: 10 });
  wrap.cellWidth = cellWidth;
  wrap.viewportWidth = viewportWidth;
  return { doc, wrap };
}

describe("WrapView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not wrap until both the font and the panel are measured", () => {
    const { wrap } = view("a ".repeat(50), { cellWidth: 0, viewportWidth: 0 });
    expect(wrap.wraps).toBe(false);
    expect(wrap.cols).toBe(Infinity);
    expect(wrap.layout.rowCount).toBe(1);

    wrap.cellWidth = 10;
    expect(wrap.wraps).toBe(false);
    wrap.viewportWidth = 224;
    expect(wrap.wraps).toBe(true);
  });

  it("fits the cells the panel holds inside its padding", () => {
    expect(view("").wrap.cols).toBe(20);
  });

  it("keeps rows at least the minimum wide in a squeezed panel", () => {
    expect(view("", { viewportWidth: 40 }).wrap.cols).toBe(10);
  });

  it("lays out the document's lines in rows", () => {
    const { layout } = view("hello brave world, how are you\nshort").wrap;
    expect(layout.rowStarts(0)).toEqual([0, 19]);
    expect(layout.firstRow(1)).toBe(2);
    expect(layout.rowCount).toBe(3);
  });

  it("rewraps when the panel narrows", () => {
    const { wrap } = view("hello brave world, how are you");
    expect(wrap.layout.rowCount).toBe(2);
    wrap.viewportWidth = 174; // 15 cells
    expect(wrap.layout.rowCount).toBe(3);
  });

  it("rewraps as the document is edited", () => {
    const { doc, wrap } = view("short");
    expect(wrap.layout.rowCount).toBe(1);
    doc.insert({ line: 0, column: 5 }, " and now much longer than a row");
    expect(wrap.layout.rowCount).toBe(2);
  });

  it("keeps its layout when Reed replaces the state without an edit", async () => {
    const { doc, wrap } = view("hello brave world, how are you");
    doc.insert({ line: 0, column: 5 }, "\nand a new line that is long enough to wrap");
    const before = wrap.layout;
    const state = doc.state;
    const layout = vi.spyOn(LineWrapper.prototype, "layout");

    // The line break leaves Reed's line index to reconcile in the background.
    await vi.waitFor(() => expect(doc.state).not.toBe(state));
    expect(wrap.layout).toBe(before);
    expect(layout).not.toHaveBeenCalled();
  });

  it("counts cells to a pixel offset, and none before the font is measured", () => {
    const { wrap } = view("");
    expect(wrap.cellsAt(35)).toBe(3.5);
    wrap.cellWidth = 0;
    expect(wrap.cellsAt(35)).toBe(0);
  });

  it("draws unwrapped, and warns once, when its lines disagree with the document's", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { doc, wrap } = view("one long line that would wrap\ntwo");
    vi.spyOn(doc, "text").mockReturnValue("one long line that would wrap");

    expect(wrap.layout.rowCount).toBe(2);
    expect(wrap.layout.rowStarts(0)).toEqual([0]);
    // Laying out again at another width disagrees again, but says nothing more.
    wrap.viewportWidth = 174;
    expect(wrap.layout.rowCount).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
  });
});
