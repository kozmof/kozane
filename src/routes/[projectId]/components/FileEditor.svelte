<script lang="ts">
  import { css, cx } from "styled-system/css";
  import EditorSurface, { type EditorMode } from "./EditorSurface.svelte";
  import type {
    EditorSession,
    EditorSessionContext,
  } from "../lib/editor/editor-session.svelte.js";
  import { createVimState, handleVimKey, type VimState } from "../lib/editor/vim.js";

  let {
    session,
    ctx,
    vimMode = false,
    readonly = false,
    width = $bindable(null),
    onClose,
  }: {
    session: EditorSession;
    ctx: EditorSessionContext;
    /** `ui.editorVimMode`. Off means the surface's own key handling is all there is. */
    vimMode?: boolean;
    readonly?: boolean;
    /**
     * Panel width in pixels, or null until it has been dragged, when the responsive
     * default applies. Owned by the page rather than held here so that it outlives a
     * close: this component keeps its own `{#if}` and so is never unmounted today, but
     * resting the requirement on that would make wrapping it in one elsewhere silently
     * reset the width.
     */
    width?: number | null;
    onClose: () => void;
  } = $props();

  /** Narrow enough to still be a file, and never so wide the board behind it is gone. */
  const MIN_WIDTH = 320;
  const EDGE_MARGIN = 120;
  const KEY_STEP = 16;

  let panelEl: HTMLDivElement | undefined = $state();
  let surface: { focus: () => void } | undefined = $state();
  let vim = $state<VimState>(createVimState());

  const mode = $derived<EditorMode>(vimMode ? vim.mode : "insert");

  // The keyboard belongs to this panel for as long as it is up. Without it, the board's
  // single-key shortcuts are still live behind the overlay: `b` would toggle the side
  // panels and `x` would remove a warp, while the file being typed into took neither.
  $effect(() => {
    if (session.isOpen && panelEl && !panelEl.contains(document.activeElement)) surface?.focus();
  });

  // A file that arrives fresh starts in normal mode when vim is on, whatever the last one
  // was left in.
  $effect(() => {
    void session.file;
    vim = createVimState();
  });

  async function save(): Promise<void> {
    await session.save(ctx);
  }

  function close(): void {
    session.close();
    onClose();
  }

  function onSurfaceKey(event: KeyboardEvent): boolean {
    if (!vimMode || !session.doc) return false;
    const result = handleVimKey(vim, event, session.doc, session.caret, readonly);
    if (!result) return false;
    vim = result.vim;
    session.caret = result.caret;
    session.anchor = result.anchor;
    // A key vim claimed is vim's alone. Without this the `Escape` that leaves insert mode
    // would go on to the panel handler below, which — reading a mode this line has already
    // changed to normal — would take it as the Escape that closes the file.
    event.stopPropagation();
    return true;
  }

  function onPanelKey(event: KeyboardEvent): void {
    // Nothing typed at an open file is meant for the board behind it.
    event.stopPropagation();

    if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      if (!readonly) void save();
      return;
    }
    // Escape closes, but not out from under an unsaved change, and not while vim is using
    // it to leave insert mode.
    if (event.key === "Escape" && !session.dirty && !(vimMode && vim.mode === "insert")) {
      event.preventDefault();
      close();
    }
  }

  /**
   * The width the panel is drawn at.
   *
   * `clamp` rather than a stored number held inside bounds, so a window resized narrower
   * than the width someone dragged to does not leave the panel hanging off the edge. The
   * value survives the resize, and comes back when there is room for it again.
   */
  const panelWidth = $derived(
    width === null
      ? "min(760px, 70vw)"
      : `clamp(${MIN_WIDTH}px, ${width}px, calc(100vw - ${EDGE_MARGIN}px))`,
  );

  /**
   * Pixels wide right now, whether that came from a drag or from the default. Bound rather
   * than measured on demand so the splitter can report it, and so a drag that starts from
   * the responsive default has a number to start from.
   */
  let panelPx = $state(0);

  function currentWidth(): number {
    // The stored width wins once there is one: it is what the panel was last asked to be,
    // and reading the rendered box back instead would round-trip through the CSS clamp and
    // lose a drag that ran past the edge. Measurement is only for the first drag, which
    // starts from whatever the responsive default worked out to.
    return width ?? (panelPx || panelEl?.getBoundingClientRect().width || MIN_WIDTH);
  }

  function resizeTo(px: number): void {
    // The ceiling is applied in CSS, which knows the viewport; the floor is applied here so
    // the stored number cannot drift below it while a drag runs off the right of the screen.
    width = Math.max(MIN_WIDTH, Math.round(px));
  }

  function onHandleMousedown(event: MouseEvent): void {
    if (event.button !== 0) return;
    // Keeps the drag from selecting the text it passes over, and from moving focus.
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = currentWidth();

    // Tracked on the window so a pointer that runs past the panel keeps resizing rather
    // than stopping at its edge — the same reason the surface tracks a selection drag there.
    const onMove = (move: MouseEvent) => resizeTo(startWidth + (startX - move.clientX));
    const onUp = () => {
      globalThis.removeEventListener("mousemove", onMove);
      globalThis.removeEventListener("mouseup", onUp);
    };
    globalThis.addEventListener("mousemove", onMove);
    globalThis.addEventListener("mouseup", onUp);
  }

  function onHandleKeydown(event: KeyboardEvent): void {
    // Left widens, because the edge being moved is the panel's left one.
    if (event.key === "ArrowLeft") resizeTo(currentWidth() + KEY_STEP);
    else if (event.key === "ArrowRight") resizeTo(currentWidth() - KEY_STEP);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const barButton = css({
    padding: "3px 9px",
    fontFamily: "inherit",
    fontSize: "11.5px",
    background: "transparent",
    border: "1px solid token(colors.neutral.border)",
    borderRadius: "2px",
    color: "ink.secondary",
    cursor: "pointer",
    "&:hover:not(:disabled)": { backgroundColor: "neutral.bg" },
    "&:disabled": { color: "neutral.disabled", cursor: "default" },
  });
</script>

{#if session.isOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={panelEl}
    class={css({
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      display: "flex",
      flexDirection: "column",
      zIndex: "60",
      background: "ink.white",
      borderLeft: "1px solid token(colors.neutral.border)",
    })}
    role="dialog"
    aria-label={`Editing ${session.file?.path ?? ""}`}
    onkeydown={onPanelKey}
    tabindex="-1"
    style:width={panelWidth}
    bind:clientWidth={panelPx}
  >
    <!-- The left edge, as something to take hold of. It sits over the panel's own padding
         rather than over any text, so widening the grab area costs no clickable line.

         A focusable separator is a window splitter in ARIA terms, which is an interactive
         role; the rule below only knows the non-focusable kind, so it is exempted rather
         than the tabindex dropped to quiet it. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class={css({
        position: "absolute",
        top: "0",
        bottom: "0",
        left: "0",
        width: "6px",
        cursor: "col-resize",
        zIndex: "1",
        "&:hover": { backgroundColor: "select.bg" },
        "&:focus-visible": { outline: "2px solid token(colors.select.accent)", outlineOffset: "0" },
      })}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor"
      aria-valuenow={Math.round(currentWidth())}
      aria-valuemin={MIN_WIDTH}
      tabindex="0"
      onmousedown={onHandleMousedown}
      onkeydown={onHandleKeydown}
      data-testid="editor-resize"
    ></div>

    <!-- Header -->
    <div
      class={css({
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "7px 10px",
        borderBottom: "1px solid token(colors.neutral.border)",
        fontSize: "11.5px",
        color: "ink.secondary",
        flexShrink: "0",
      })}
    >
      <span class={css({ color: "taskspace.text", flexShrink: "0" })}>
        {session.file?.taskspaceName}
      </span>
      <span class={css({ color: "neutral.muted" })}>/</span>
      <span
        class={css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}
        title={session.file?.path}
      >
        {session.file?.path}
      </span>
      {#if session.dirty}
        <span class={css({ color: "state.error" })} title="Unsaved changes">●</span>
      {/if}
      {#if !readonly}
        <button
          class={barButton}
          onclick={save}
          disabled={session.saving || !session.dirty || session.loading}
        >
          {session.saving ? "Saving…" : "Save"}
        </button>
      {/if}
      <button class={barButton} onclick={close}>Close</button>
    </div>

    <!-- Conflict and error notices -->
    {#if session.conflict}
      <div
        class={css({
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "6px 10px",
          background: "select.surface",
          fontSize: "11.5px",
          color: "ink.secondary",
          flexShrink: "0",
        })}
        role="alert"
      >
        <span class={css({ flex: "1" })}>
          This file changed on disk since it was opened. Saving would discard that change.
        </span>
        <button class={barButton} onclick={() => session.reload(ctx)}>Reload from disk</button>
      </div>
    {:else if session.error}
      <div
        class={css({
          padding: "6px 10px",
          background: "state.error",
          color: "#fff",
          fontSize: "11.5px",
          flexShrink: "0",
        })}
        role="alert"
      >
        {session.error}
      </div>
    {/if}

    <!-- The text itself -->
    {#if session.loading}
      <div class={css({ padding: "10px", fontSize: "11.5px", color: "neutral.subtle" })}>
        Loading…
      </div>
    {:else if session.doc}
      <EditorSurface
        bind:this={surface}
        doc={session.doc}
        bind:caret={session.caret}
        bind:anchor={session.anchor}
        {mode}
        {readonly}
        onKeydown={onSurfaceKey}
      />
    {/if}

    <!-- Status bar -->
    <div
      class={css({
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "4px 10px",
        borderTop: "1px solid token(colors.neutral.border)",
        fontSize: "11px",
        color: "neutral.subtle",
        flexShrink: "0",
      })}
    >
      {#if vimMode}
        <span
          class={cx(
            css({
              padding: "1px 7px",
              borderRadius: "2px",
              fontSize: "10px",
              fontWeight: "bold",
              letterSpacing: "0.5px",
              color: "#fff",
            }),
            vim.mode === "normal" ? css({ background: "select.dim" }) : css({ background: "taskspace.text" }),
          )}
          data-testid="vim-mode"
        >
          {vim.mode === "normal" ? "NORMAL" : "INSERT"}
        </span>
        {#if vim.pending}
          <span class={css({ color: "state.error" })}>{vim.pending}_</span>
        {/if}
      {/if}
      <span>{session.doc?.lineCount ?? 0} lines</span>
      <span class={css({ marginLeft: "auto" })}>
        Ln {session.caret.line + 1}, Col {session.caret.column + 1}
      </span>
    </div>
  </div>
{/if}
