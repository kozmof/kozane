<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Caret, EditorDocument } from "../lib/editor/document-store.svelte.js";
  import { orderCarets, sameCaret } from "../lib/editor/document-store.svelte.js";
  import {
    caretPoint,
    domMeasurer,
    pointToCaret,
    selectionRects,
    visibleRange,
  } from "../lib/editor/geometry.js";
  import { TAB_SIZE } from "../lib/editor/wrap.js";
  import { WrapView } from "../lib/editor/wrap-view.svelte.js";
  import { handleSurfaceKey, type SurfaceKeyHost } from "../lib/editor/surface-keys.js";
  import {
    RowElements,
    caretRowsAway,
    caretWidth as measureCaretWidth,
    drawnRows,
  } from "../lib/editor/surface-rows.js";

  export type EditorMode = "insert" | "normal";

  let {
    doc,
    caret = $bindable(),
    anchor = $bindable(),
    mode = "insert",
    readonly = false,
    onKeydown,
  }: {
    doc: EditorDocument;
    /** Caret position as a zero-based line and UTF-16 column. */
    caret: Caret;
    /** The other end of the selection, or null when there is none. */
    anchor: Caret | null;
    /** Only the cursor's shape and whether typing inserts. Vim owns the rest. */
    mode?: EditorMode;
    readonly?: boolean;
    /**
     * Offer each key to the host first. A true result skips default handling, allowing Vim
     * mode without coupling the surface to it.
     */
    onKeydown?: (event: KeyboardEvent) => boolean;
  } = $props();

  /** Fixed line height used to calculate each line's vertical position. */
  const LINE_HEIGHT = 20;
  const FONT_SIZE = 12.5;
  const PAD_X = 12;
  const PAD_Y = 8;
  const OVERSCAN = 6;
  /** Narrowest row wrapping allows, so a squeezed panel still shows whole words. */
  const MIN_COLS = 10;
  /** Text measured once to find the font's cell width. */
  const PROBE = "0".repeat(64);

  let scrollEl: HTMLDivElement | undefined = $state();
  let sinkEl: HTMLTextAreaElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(400);
  let probeEl: HTMLSpanElement | undefined = $state();
  let focused = $state(false);

  const wrap = new WrapView(() => doc, { padding: PAD_X * 2, minCols: MIN_COLS });
  const layout = $derived(wrap.layout);

  const rowElements = new RowElements(() => scrollEl);
  const rowElement = (line: number, index: number) => rowElements.get(line, index);

  // Measure the font's cell width, again once web fonts finish loading and whenever a font
  // loads later, such as a fallback for characters first typed now. Without layout, as in
  // tests, the width stays 0 and lines do not wrap.
  $effect(() => {
    const probe = probeEl;
    if (!probe) return;
    let live = true;
    const read = () => {
      if (live) wrap.cellWidth = probe.getBoundingClientRect().width / PROBE.length;
    };
    read();
    const fonts = document.fonts;
    void fonts?.ready.then(read);
    fonts?.addEventListener?.("loadingdone", read);
    return () => {
      live = false;
      fonts?.removeEventListener?.("loadingdone", read);
    };
  });

  /**
   * Display uncommitted IME text without editing the document. Commit at `compositionend`
   * so canceled compositions leave no edit or undo entry.
   */
  let preedit = $state("");
  let composing = $state(false);

  const measure = domMeasurer(rowElement, () => layout);

  const window_ = $derived(
    visibleRange(
      { scrollTop, height: viewportHeight, lineHeight: LINE_HEIGHT, rowCount: layout.rowCount },
      OVERSCAN,
    ),
  );
  /** Rows drawn, as `[first, end)`. */
  const shownRows = $derived<[number, number]>([
    window_.startRow,
    window_.startRow + window_.visibleRowCount,
  ]);
  const lines = $derived.by(() => {
    const first = layout.rowAt(shownRows[0]).line;
    const last = layout.rowAt(shownRows[1] - 1).line;
    return doc.visibleLines(first, last - first + 1, 0);
  });

  /** The drawn rows of the drawn lines. A long line draws only its rows in view. */
  const rows = $derived(drawnRows(lines, layout, shownRows));
  const contentHeight = $derived(layout.rowCount * LINE_HEIGHT);
  /** Which of its line's rows the caret is on, where IME preedit text is drawn. */
  const caretRowIndex = $derived(layout.rowIndex(caret.line, caret.column));

  const selection = $derived.by(() => {
    if (!anchor || sameCaret(anchor, caret)) return null;
    return orderCarets(anchor, caret);
  });

  let rects = $state<ReturnType<typeof selectionRects>>([]);
  let caretXY = $state({ x: 0, y: 0 });
  let caretWidth = $state(2);
  /** The IME sink reaches from the caret to the row's end, so preedit fits without scrolling. */
  const sinkWidth = $derived(Math.max(1, wrap.viewportWidth - caretXY.x - PAD_X * 2));

  // DOM ranges must see the newly rendered text. Effects run after DOM updates, while
  // derived values used during rendering can still measure the previous line content.
  $effect(() => {
    void doc.state.revision;
    void lines;
    void composing;
    void preedit;
    rects = selection
      ? selectionRects(selection.start, selection.end, {
          lineHeight: LINE_HEIGHT,
          measure,
          mountedLines: lines.map((line) => line.lineNumber),
          layout,
          shownRows,
        })
      : [];
    caretXY = caretPoint(caret, LINE_HEIGHT, measure, layout);
    caretWidth = measureCaretWidth(measures, caret, mode, FONT_SIZE);
  });

  export function focus(): void {
    sinkEl?.focus();
  }

  function setCaret(next: Caret, extend: boolean): void {
    const clamped = doc.clamp(next);
    if (extend) anchor ??= caret;
    else anchor = null;
    caret = clamped;
  }

  function collapse(): void {
    anchor = null;
  }

  /** The selected span, ordered, or null when the selection is empty. */
  function selected(): { start: Caret; end: Caret } | null {
    return selection;
  }

  function deleteSelection(): boolean {
    const span = selected();
    if (!span) return false;
    // Preserve the caret's end of the selection so undo restores it after a drag in either
    // direction.
    caret = doc.delete(span.start, span.end, caret);
    collapse();
    return true;
  }

  function insertText(text: string): void {
    deleteSelection();
    caret = doc.insert(caret, text);
    collapse();
  }

  // ── Keyboard ──────────────────────────────────────────────────
  function moveTo(next: Caret, extend: boolean): void {
    setCaret(next, extend);
  }

  /**
   * The x that vertical moves aim for, and the caret they left. Kept while the caret stays
   * where the last vertical move put it, so passing through a short row does not pull later
   * rows toward its end. Any other move drops it.
   */
  let goal: { caret: Caret; x: number; offset: number } | null = null;

  /** Caret measurements read the surface's current layout and drawn rows. */
  const measures = {
    get doc() {
      return doc;
    },
    get layout() {
      return layout;
    },
    wrap,
    measure,
    rowElement,
  };

  function moveByRows(by: number, extend: boolean): void {
    const kept = goal && sameCaret(goal.caret, caret) ? goal : null;
    const x = kept ? kept.x : caretXY.x;
    const offset = kept
      ? kept.offset
      : caret.column - layout.rowStarts(caret.line)[layout.rowIndex(caret.line, caret.column)];
    moveTo(caretRowsAway(measures, caret, by, x, offset), extend);
    goal = { caret, x, offset };
  }

  function handleKeydown(event: KeyboardEvent): void {
    // Let keys reach the host so it can handle save and close actions and stop them from
    // reaching the board.
    //
    // During composition, leave input to the browser and IME. Commit text at compositionend.
    if (composing) return;

    if (onKeydown?.(event)) {
      event.preventDefault();
      return;
    }

    handleSurfaceKey(event, keyHost);
  }

  /** The surface's state and edits, as the default key handling sees them. */
  const keyHost: SurfaceKeyHost = {
    get doc() {
      return doc;
    },
    get caret() {
      return caret;
    },
    set caret(next) {
      caret = next;
    },
    get anchor() {
      return anchor;
    },
    set anchor(next) {
      anchor = next;
    },
    get readonly() {
      return readonly;
    },
    get pageRows() {
      return Math.floor(viewportHeight / LINE_HEIGHT);
    },
    moveTo,
    moveByRows,
    collapse,
    deleteSelection,
    insertText,
  };

  // Keep composition text in the input sink and display the preedit inline. Update the
  // document only when composition commits.
  function handleCompositionStart(): void {
    composing = true;
    preedit = "";
    if (!readonly) deleteSelection();
  }

  function handleCompositionUpdate(event: CompositionEvent): void {
    preedit = event.data ?? "";
    // A word longer than the rest of the row would scroll the sink and move the IME window.
    // Keep the word's start pinned at the caret.
    if (sinkEl) sinkEl.scrollLeft = 0;
  }

  function handleCompositionEnd(event: CompositionEvent): void {
    composing = false;
    const composed = event.data ?? "";
    preedit = "";
    if (sinkEl) sinkEl.value = "";
    // Insert the committed composition once so one undo removes it in full.
    if (composed && !readonly) insertText(composed);
  }

  /**
   * Handle text input that arrives without keydown, such as mobile keyboard commits or
   * dictation. Composition uses its separate handler.
   */
  function handleInput(): void {
    if (composing || !sinkEl) return;
    const typed = sinkEl.value;
    sinkEl.value = "";
    if (typed && !readonly) insertText(typed);
  }

  function handlePaste(event: ClipboardEvent): void {
    event.preventDefault();
    if (readonly) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text) insertText(text.replace(/\r\n?/g, "\n"));
  }

  function handleCopy(event: ClipboardEvent): void {
    const span = selected();
    if (!span) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", doc.textBetween(span.start, span.end));
  }

  function handleCut(event: ClipboardEvent): void {
    const span = selected();
    if (!span) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", doc.textBetween(span.start, span.end));
    if (!readonly) deleteSelection();
  }

  // ── Pointer ───────────────────────────────────────────────────
  function caretFromEvent(event: MouseEvent): Caret | null {
    const sizer = scrollEl?.firstElementChild as HTMLElement | undefined;
    if (!sizer) return null;
    const box = sizer.getBoundingClientRect();
    // Subtract padding to convert pointer positions to text coordinates. Add the same offsets
    // back when drawing the caret and selection.
    return pointToCaret(
      event.clientX - box.left - PAD_X,
      event.clientY - box.top - PAD_Y,
      LINE_HEIGHT,
      measure,
      layout,
    );
  }

  /** True for a click on the native scrollbar rather than on the text. */
  function onScrollbar(event: MouseEvent): boolean {
    if (!scrollEl) return false;
    const { clientWidth, clientHeight } = scrollEl;
    // Without measurable layout, do not classify the click as a scrollbar drag.
    if (clientWidth === 0 || clientHeight === 0) return false;
    const box = scrollEl.getBoundingClientRect();
    // `clientWidth`/`clientHeight` exclude the scrollbars, so a point past either is on one.
    return event.clientX - box.left > clientWidth || event.clientY - box.top > clientHeight;
  }

  function handleMousedown(event: MouseEvent): void {
    if (event.button !== 0) return;
    // Dragging the scrollbar is the browser's, and preventing its default below would stop
    // the thumb from moving.
    if (onScrollbar(event)) return;

    const at = caretFromEvent(event);
    if (!at) return;

    // Prevent mousedown's default focus change from blurring the input sink just focused by
    // this handler.
    event.preventDefault();
    setCaret(at, event.shiftKey);
    focus();

    // Dragging is tracked on the window rather than the surface so a selection that runs
    // off the panel keeps extending instead of stopping at the edge.
    const onMove = (move: MouseEvent) => {
      const to = caretFromEvent(move);
      if (to) setCaret(to, true);
    };
    const onUp = () => {
      globalThis.removeEventListener("mousemove", onMove);
      globalThis.removeEventListener("mouseup", onUp);
    };
    globalThis.addEventListener("mousemove", onMove);
    globalThis.addEventListener("mouseup", onUp);
  }

  // Follow caret changes without depending on reactive scroll state. Read the element's
  // current viewport directly so manual scrolling does not trigger a jump back to the caret.
  $effect(() => {
    const top = layout.rowOf(caret.line, caret.column) * LINE_HEIGHT;
    if (!scrollEl) return;
    const viewTop = scrollEl.scrollTop;
    const viewHeight = scrollEl.clientHeight;
    // Wait for a nonzero viewport height before scrolling to keep the caret visible.
    if (viewHeight === 0) return;
    if (top < viewTop) scrollEl.scrollTop = top;
    else if (top + LINE_HEIGHT > viewTop + viewHeight)
      scrollEl.scrollTop = top + LINE_HEIGHT - viewHeight;
  });

  const lineClass = css({
    position: "absolute",
    left: "0",
    right: "0",
    whiteSpace: "pre",
    tabSize: String(TAB_SIZE),
    height: "20px",
    lineHeight: "20px",
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={scrollEl}
  class={css({
    position: "relative",
    flex: "1",
    overflow: "auto",
    background: "ink.white",
    fontFamily: "mono",
    fontSize: "12.5px",
    color: "ink.black",
    cursor: "text",
    outline: "none",
    // Reserve scrollbar space so showing it cannot change row width and trigger rewrapping.
    scrollbarGutter: "stable",
    // Contain the rows', cursor's, and input sink's z-indexes so they stack only against
    // each other. Otherwise rows spanning the panel paint over its resize handle and take
    // its presses wherever there is text.
    isolation: "isolate",
  })}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
  onmousedown={handleMousedown}
  bind:clientHeight={viewportHeight}
  bind:clientWidth={wrap.viewportWidth}
  data-testid="editor-surface"
>
  <!-- Size the scroll area for the whole document, including virtualized lines. Keep this element unpadded because its children are absolutely positioned. Apply text padding to lines and caret or selection coordinates instead. -->
  <div
    class={css({ position: "relative", width: "100%", boxSizing: "border-box" })}
    style:height={`${contentHeight + PAD_Y * 2}px`}
  >
    <!-- Selection, painted under the text as rectangles. -->
    {#each rects as rect, i (i)}
      <div
        class={css({
          position: "absolute",
          background: "select.bg",
          pointerEvents: "none",
          zIndex: "0",
        })}
        style:top={`${rect.top + PAD_Y}px`}
        style:left={`${rect.left + PAD_X}px`}
        style:width={rect.width === null
          ? `calc(100% - ${rect.left + PAD_X}px)`
          : `${rect.width}px`}
        data-testid="editor-selection"
        style:height={`${rect.height}px`}
      ></div>
    {/each}

    <!-- Measures the font's cell width for wrapping. Never visible. The empty clipping box
         keeps the probe from widening the scroll area, so a row the font draws wider than its
         cells count scrolls into view rather than overflowing unseen. -->
    <div
      class={css({ position: "absolute", width: "0", height: "0", overflow: "hidden" })}
      aria-hidden="true"
    >
      <span bind:this={probeEl} class={css({ visibility: "hidden", whiteSpace: "pre" })}
        >{PROBE}</span
      >
    </div>

    <!-- Draw only the windowed rows, each absolutely positioned by row number. A wrapped line
         draws one element per row, all carrying its line number. -->
    {#each rows as row (row.key)}
      <div
        class={lineClass}
        data-line={row.line}
        data-row-index={row.index}
        style:top={`${row.row * LINE_HEIGHT + PAD_Y}px`}
        style:padding-left={`${PAD_X}px`}
        style:padding-right={`${PAD_X}px`}
        style:z-index="1"
      >{#if composing && preedit && row.line === caret.line && row.index === caretRowIndex}{row.text.slice(
            0,
            caret.column - row.start,
          )}<span
            class={css({ textDecoration: "underline", textUnderlineOffset: "2px" })}
            data-preedit>{preedit}</span
          >{row.text.slice(caret.column - row.start)}{:else}{row.text}{/if}</div>
    {/each}

    <!-- The cursor is a sibling of the text, never spliced into it, so drawing it cannot move
         a single character on the line. -->
    {#if focused && !composing}
      <div
        class={cx(
          css({ position: "absolute", pointerEvents: "none", zIndex: "2" }),
          mode === "normal"
            ? css({ background: "select.accent", opacity: "0.35" })
            : css({ background: "ink.black" }),
        )}
        style:top={`${caretXY.y + PAD_Y}px`}
        style:left={`${caretXY.x + PAD_X}px`}
        style:width={`${caretWidth}px`}
        style:height={`${LINE_HEIGHT}px`}
        data-testid="editor-cursor"
      ></div>
    {/if}

    <!-- The IME sink. Invisible, one row tall, parked at the caret and reaching to the row's
         end. IMEs place the candidate window from the sink's preedit position, so the sink
         must span the whole row, must not wrap, and must not scroll, or the window can cover
         the line or drift while a word is typed. It renders nothing and holds no document
         text. -->
    <textarea
      bind:this={sinkEl}
      wrap="off"
      class={css({
        position: "absolute",
        padding: "0",
        margin: "0",
        whiteSpace: "pre",
        pointerEvents: "none",
        border: "none",
        outline: "none",
        resize: "none",
        overflow: "hidden",
        opacity: "0",
        zIndex: "3",
        fontFamily: "mono",
        fontSize: "12.5px",
      })}
      style:top={`${caretXY.y + PAD_Y}px`}
      style:left={`${caretXY.x + PAD_X}px`}
      style:width={`${sinkWidth}px`}
      style:height={`${LINE_HEIGHT}px`}
      style:line-height={`${LINE_HEIGHT}px`}
      onkeydown={handleKeydown}
      oninput={handleInput}
      oncompositionstart={handleCompositionStart}
      oncompositionupdate={handleCompositionUpdate}
      oncompositionend={handleCompositionEnd}
      onpaste={handlePaste}
      oncopy={handleCopy}
      oncut={handleCut}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      aria-label="File contents"
      data-testid="editor-sink"
    ></textarea>
  </div>
</div>
