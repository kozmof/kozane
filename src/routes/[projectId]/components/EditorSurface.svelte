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
    /** Where the caret is, in (line, column) characters. */
    caret: Caret;
    /** The other end of the selection, or null when there is none. */
    anchor: Caret | null;
    /** Only the cursor's shape and whether typing inserts. Vim owns the rest. */
    mode?: EditorMode;
    readonly?: boolean;
    /**
     * First refusal on every key. Returning true means the key was dealt with and the
     * default handling below is skipped — this is the whole of the seam vim mode plugs
     * into, so the surface itself never has to know a mode exists.
     */
    onKeydown?: (event: KeyboardEvent) => boolean;
  } = $props();

  /** Fixed, and the render layer leans on it: a line's y is a multiplication, not a measurement. */
  const LINE_HEIGHT = 20;
  const FONT_SIZE = 12.5;
  const PAD_X = 12;
  const PAD_Y = 8;
  const OVERSCAN = 6;

  let scrollEl: HTMLDivElement | undefined = $state();
  let sinkEl: HTMLTextAreaElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(400);
  let focused = $state(false);

  /**
   * The line elements currently in the DOM, by line number. Not reactive: the measurer
   * reads it when an event asks a question, never during rendering.
   *
   * Filled by the `lineEl` action below rather than by `bind:this` into a member, which is
   * what Svelte warns about on a plain object — and the action's teardown removes the entry,
   * so a line scrolled out of the window leaves nothing behind for the measurer to find.
   */
  const lineEls: Record<number, HTMLDivElement | undefined> = {};

  function lineEl(node: HTMLDivElement, lineNumber: number) {
    lineEls[lineNumber] = node;
    return {
      destroy() {
        delete lineEls[lineNumber];
      },
    };
  }

  /**
   * Text the IME is still composing. Held here and drawn into the line rather than
   * dispatched, so an abandoned composition leaves no edit and no undo entry behind. The
   * document only hears about it once `compositionend` says what it settled on.
   */
  let preedit = $state("");
  let composing = $state(false);

  const measure = domMeasurer((line) => lineEls[line] ?? null);

  const window_ = $derived(
    visibleRange(
      { scrollTop, height: viewportHeight, lineHeight: LINE_HEIGHT, lineCount: doc.lineCount },
      OVERSCAN,
    ),
  );
  const lines = $derived(doc.visibleLines(window_.startLine, window_.visibleLineCount, 0));
  const contentHeight = $derived(Math.max(1, doc.lineCount) * LINE_HEIGHT);

  const selection = $derived.by(() => {
    if (!anchor || sameCaret(anchor, caret)) return null;
    return orderCarets(anchor, caret);
  });

  // Recomputed against the document's revision as well as the carets, because the same
  // (line, column) pair sits at a different pixel once the text around it has changed.
  const rects = $derived.by(() => {
    void doc.state.revision;
    void lines;
    if (!selection) return [];
    return selectionRects(selection.start, selection.end, LINE_HEIGHT, measure, (line) =>
      doc.lineText(line).length,
    );
  });

  const caretXY = $derived.by(() => {
    void doc.state.revision;
    void lines;
    return caretPoint(caret, LINE_HEIGHT, measure);
  });

  /** Width of the block cursor in normal mode: the cell the caret is sitting on. */
  const caretWidth = $derived.by(() => {
    void doc.state.revision;
    if (mode !== "normal") return 2;
    const text = doc.lineText(caret.line);
    if (caret.column >= text.length) return FONT_SIZE * 0.6;
    return Math.max(
      2,
      measure.columnToX(caret.line, caret.column + 1) - measure.columnToX(caret.line, caret.column),
    );
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
    // The live caret is one end of the selection, and which end depends on the direction
    // it was dragged. It is where undo has to put it back to.
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

  function handleKeydown(event: KeyboardEvent): void {
    // Propagation is deliberately not stopped here. Keys typed at the surface still have
    // to reach whatever is hosting it: `Escape` closes the file and the save accelerator
    // saves it, and both are the overlay's to act on. Keeping them off the board behind is
    // that host's job, which it is in a position to do — this one is not, because it
    // cannot tell the difference between a key meant for itself and one meant for its
    // parent without claiming both.

    // The browser and the IME own the keyboard for the length of a composition. What it
    // settles on arrives at compositionend; nothing before then is ours to act on.
    if (composing) return;

    if (onKeydown?.(event)) {
      event.preventDefault();
      return;
    }

    const extend = event.shiftKey;
    const accel = event.ctrlKey || event.metaKey;
    const lastLine = Math.max(0, doc.lineCount - 1);

    // Left to the parent: saving and closing are the overlay's business, not the surface's.
    if (accel && (event.key === "s" || event.key === "S")) return;

    if (accel) {
      switch (event.key) {
        case "z":
        case "Z": {
          event.preventDefault();
          // Where the edit was, not where the caret happened to be sitting: an undo that
          // leaves the caret behind sends you looking for what just changed.
          const to = event.shiftKey ? doc.redo() : doc.undo();
          collapse();
          caret = doc.clamp(to ?? caret);
          return;
        }
        case "y": {
          event.preventDefault();
          const to = doc.redo();
          collapse();
          caret = doc.clamp(to ?? caret);
          return;
        }
        case "a":
          event.preventDefault();
          anchor = { line: 0, column: 0 };
          caret = { line: lastLine, column: doc.lineText(lastLine).length };
          return;
        case "Home":
          event.preventDefault();
          moveTo({ line: 0, column: 0 }, extend);
          return;
        case "End":
          event.preventDefault();
          moveTo({ line: lastLine, column: doc.lineText(lastLine).length }, extend);
          return;
      }
      // Any other accelerator — copy, cut, paste — belongs to the browser, which turns it
      // into the clipboard event handled below.
      return;
    }

    switch (event.key) {
      case "ArrowLeft": {
        event.preventDefault();
        if (caret.column > 0)
          moveTo({ line: caret.line, column: doc.columnBefore(caret.line, caret.column) }, extend);
        else if (caret.line > 0)
          moveTo({ line: caret.line - 1, column: doc.lineText(caret.line - 1).length }, extend);
        return;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (caret.column < doc.lineText(caret.line).length)
          moveTo({ line: caret.line, column: doc.columnAfter(caret.line, caret.column) }, extend);
        else if (caret.line < lastLine) moveTo({ line: caret.line + 1, column: 0 }, extend);
        return;
      }
      case "ArrowUp":
        event.preventDefault();
        moveTo({ line: caret.line - 1, column: caret.column }, extend);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveTo({ line: caret.line + 1, column: caret.column }, extend);
        return;
      case "PageUp":
        event.preventDefault();
        moveTo(
          { line: caret.line - Math.floor(viewportHeight / LINE_HEIGHT), column: caret.column },
          extend,
        );
        return;
      case "PageDown":
        event.preventDefault();
        moveTo(
          { line: caret.line + Math.floor(viewportHeight / LINE_HEIGHT), column: caret.column },
          extend,
        );
        return;
      case "Home":
        event.preventDefault();
        moveTo({ line: caret.line, column: 0 }, extend);
        return;
      case "End":
        event.preventDefault();
        moveTo({ line: caret.line, column: doc.lineText(caret.line).length }, extend);
        return;
    }

    if (readonly) return;

    switch (event.key) {
      case "Enter":
        event.preventDefault();
        insertText("\n");
        return;
      case "Tab":
        event.preventDefault();
        insertText("  ");
        return;
      case "Backspace": {
        event.preventDefault();
        if (deleteSelection()) return;
        // Backspace takes what is behind the caret, so the caret was at the end of the
        // range rather than its start — which is where undo belongs.
        if (caret.column > 0)
          caret = doc.delete(
            { line: caret.line, column: doc.columnBefore(caret.line, caret.column) },
            caret,
            caret,
          );
        else if (caret.line > 0)
          caret = doc.delete(
            { line: caret.line - 1, column: doc.lineText(caret.line - 1).length },
            caret,
            caret,
          );
        return;
      }
      case "Delete": {
        event.preventDefault();
        if (deleteSelection()) return;
        const lineLength = doc.lineText(caret.line).length;
        if (caret.column < lineLength)
          caret = doc.delete(caret, {
            line: caret.line,
            column: doc.columnAfter(caret.line, caret.column),
          });
        else if (caret.line < lastLine)
          caret = doc.delete(caret, { line: caret.line + 1, column: 0 });
        return;
      }
    }

    // A printable character. Anything longer than one code point is a named key we have
    // not claimed, and belongs to nobody.
    if ([...event.key].length === 1 && !event.altKey) {
      event.preventDefault();
      insertText(event.key);
    }
  }

  // ── IME ───────────────────────────────────────────────────────
  // The sink holds the composition; the preedit is drawn into the line so the candidate
  // text is visible where it will land, and the document hears nothing until it settles.
  function handleCompositionStart(): void {
    composing = true;
    preedit = "";
    if (!readonly) deleteSelection();
  }

  function handleCompositionUpdate(event: CompositionEvent): void {
    preedit = event.data ?? "";
  }

  function handleCompositionEnd(event: CompositionEvent): void {
    composing = false;
    const composed = event.data ?? "";
    preedit = "";
    if (sinkEl) sinkEl.value = "";
    // One insert for the whole session, so one undo takes back the word rather than
    // walking backwards through every candidate that was cycled past on the way to it.
    if (composed && !readonly) insertText(composed);
  }

  /**
   * Typed text that arrived without a keydown we could read — a candidate committed by a
   * mobile keyboard, or a dictation. Composition has its own path above; this is only for
   * what the sink accumulates outside one.
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
    // The paddings come off here because the measurer answers in text coordinates: x from
    // the first character of a line, y from the first line. They are added back when the
    // caret and the selection are drawn, which is the same pair of offsets in the other
    // direction. Leaving them on put a click a padding to the right of where it was aimed
    // and, in the bottom of a line, on the line below.
    return pointToCaret(
      event.clientX - box.left - PAD_X,
      event.clientY - box.top - PAD_Y,
      LINE_HEIGHT,
      doc.lineCount,
      measure,
    );
  }

  /** True for a click on the native scrollbar rather than on the text. */
  function onScrollbar(event: MouseEvent): boolean {
    if (!scrollEl) return false;
    const { clientWidth, clientHeight } = scrollEl;
    // Nothing measurable — no layout, so no scrollbar to be on. Answering "yes" on a zero
    // width would call every click a scrollbar drag and swallow the focus it was meant to
    // take.
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

    // The focus this moves is the whole point. A mousedown's default action puts focus on
    // the nearest focusable ancestor of what was clicked, and the surface is plain divs —
    // so the default is to focus nothing, which lands *after* this handler and blurs the
    // sink `focus()` just focused. Without this, clicking the text of an unfocused editor
    // leaves it unfocused, and the caret never comes back.
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

  // ── Following the caret ───────────────────────────────────────
  //
  // The caret is the only thing this follows. Where the view currently sits is read off the
  // element rather than from the `scrollTop` and `viewportHeight` state beside it, which
  // would make scrolling a dependency: the effect ran again on every scroll, and with the
  // caret above the new position its first branch put the view straight back on the caret.
  // A long file could not be scrolled through at all — the scrollbar sprang back to the top
  // on release, and the wheel moved nothing.
  $effect(() => {
    const top = caret.line * LINE_HEIGHT;
    if (!scrollEl) return;
    const viewTop = scrollEl.scrollTop;
    const viewHeight = scrollEl.clientHeight;
    // Before the panel has been laid out there is no view to be in or out of, and scrolling
    // against a zero height would only move the file away from the caret.
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
  })}
  onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
  onmousedown={handleMousedown}
  bind:clientHeight={viewportHeight}
  data-testid="editor-surface"
>
  <!-- The sizer is what the scrollbar measures: the whole document's height, whether or
       not the lines that make it up are currently in the DOM.

       No padding of its own. Everything inside is absolutely positioned, and an absolute
       child is placed against the padding box — so padding here moved nothing, while
       still widening the box past the scroll container and putting a horizontal scrollbar
       under every file. The gaps come from `PAD_X`/`PAD_Y`, which the lines carry as their
       own padding and the caret and selection add when they are placed. -->
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

    <!-- Text: only the window, absolutely positioned by line number. -->
    {#each lines as line (line.lineNumber)}
      <div
        use:lineEl={line.lineNumber}
        class={lineClass}
        data-line={line.lineNumber}
        style:top={`${line.lineNumber * LINE_HEIGHT + PAD_Y}px`}
        style:padding-left={`${PAD_X}px`}
        style:padding-right={`${PAD_X}px`}
        style:z-index="1"
      >{#if composing && preedit && line.lineNumber === caret.line}{line.content.slice(
            0,
            caret.column,
          )}<span
            class={css({ textDecoration: "underline", textUnderlineOffset: "2px" })}
            data-preedit>{preedit}</span
          >{line.content.slice(caret.column)}{:else}{line.content}{/if}</div>
    {/each}

    <!-- Cursor: a sibling of the text, never spliced into it, so drawing it cannot move
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

    <!-- The IME sink. One pixel, invisible, parked at the caret so the candidate window
         opens where the text will land. It renders nothing and holds no document text. -->
    <textarea
      bind:this={sinkEl}
      class={css({
        position: "absolute",
        width: "1px",
        height: "1px",
        padding: "0",
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
