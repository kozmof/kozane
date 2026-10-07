<script lang="ts">
  import { css, cx } from "styled-system/css";
  import { beforeNavigate } from "$app/navigation";
  import EditorSurface, { type EditorMode } from "./EditorSurface.svelte";
  import type {
    EditorSession,
    EditorSessionContext,
  } from "../lib/editor/editor-session.svelte.js";
  import { createVimState, handleVimKey, type VimState } from "../lib/editor/vim.js";
  import { guardUnsavedLeave, UNSAVED_LEAVE_PROMPT } from "../lib/editor/leave-guard.js";

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
     * Panel width in pixels, or null for the responsive default. The page owns this value so
     * it survives closing or remounting the editor.
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

  // Keep keyboard events within the open editor so typing cannot trigger board shortcuts.
  $effect(() => {
    if (session.isOpen && panelEl && !panelEl.contains(document.activeElement)) surface?.focus();
  });

  // A file that arrives fresh starts in normal mode when vim is on, whatever the last one
  // was left in, and with no question hanging over it from the file before.
  $effect(() => {
    void session.file;
    vim = createVimState();
    confirmingClose = false;
  });

  /**
   * Close on a press outside the panel. Use `mousedown` so dragging a text selection beyond
   * the panel does not close the file.
   */
  $effect(() => {
    if (!session.isOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!panelEl || panelEl.contains(event.target as Node)) return;
      requestClose();
    };
    globalThis.addEventListener("mousedown", onDown);
    return () => globalThis.removeEventListener("mousedown", onDown);
  });

  async function save(): Promise<void> {
    await session.save(ctx);
  }

  /**
   * Whether closing is awaiting confirmation for unsaved changes. Keep the document open
   * until the user saves or discards those changes.
   */
  let confirmingClose = $state(false);

  /** Closes, or asks first. What every route out of the panel goes through. */
  function requestClose(): void {
    if (session.dirty) {
      confirmingClose = true;
      return;
    }
    close();
  }

  function close(): void {
    confirmingClose = false;
    session.close();
    onClose();
  }

  // Guard navigation and tab closing while a file has unsaved changes. Register once and read
  // the current file state when invoked. Navigation needs an immediate confirmation result.
  beforeNavigate((nav) =>
    guardUnsavedLeave(nav, session.dirty, () => globalThis.confirm(UNSAVED_LEAVE_PROMPT)),
  );

  function onSurfaceKey(event: KeyboardEvent): boolean {
    if (!vimMode || !session.doc) return false;
    const result = handleVimKey(vim, event, session.doc, session.caret, readonly);
    if (!result) return false;
    vim = result.vim;
    session.caret = result.caret;
    session.anchor = result.anchor;
    // Stop keys claimed by Vim so Escape leaving insert mode cannot also close the editor.
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
    // Escape requests closing when Vim has not claimed it. With unsaved changes, ask for
    // confirmation. A second Escape cancels that prompt.
    if (event.key === "Escape" && !(vimMode && vim.mode === "insert")) {
      event.preventDefault();
      if (confirmingClose) confirmingClose = false;
      else requestClose();
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
    // Use the stored width after the first drag to preserve motion beyond the CSS clamp.
    // Measure the rendered width only when starting from the responsive default.
    return width ?? (panelPx || panelEl?.getBoundingClientRect().width || MIN_WIDTH);
  }

  function resizeTo(px: number): void {
    // Clamp the minimum width here and let CSS enforce the viewport-dependent maximum.
    width = Math.max(MIN_WIDTH, Math.round(px));
  }

  function onHandleMousedown(event: MouseEvent): void {
    if (event.button !== 0) return;
    // Keeps the drag from selecting the text it passes over, and from moving focus.
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = currentWidth();

    // Track resizing on the window so dragging continues beyond the panel edge.
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
    <!-- Place the resize handle over panel padding to preserve text click targets. This focusable separator is an interactive splitter, which requires the accessibility-rule exception below. -->
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
      <!-- Distinguish the taskspace and path with shades of grey. Reserve taskspace green for card-footer badges. -->
      <span class={css({ color: "neutral.secondary", flexShrink: "0" })}>
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
        <!-- Draw the unsaved marker as eight round dots. Tie the dash gap to the circumference, `2πr/8`, to keep spacing even when the radius changes. -->
        <span class={css({ color: "select.accent", display: "flex" })} title="Unsaved changes">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
            <circle
              cx="5.5"
              cy="5.5"
              r="4.5"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-dasharray="0.01 3.53"
            />
          </svg>
        </span>
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
      <button class={barButton} onclick={requestClose}>Close</button>
    </div>

    <!-- Show the unsaved-changes question before error notices because it requires an answer. -->
    {#if confirmingClose}
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
        <span class={css({ flex: "1" })}>This file has unsaved changes.</span>
        <button class={barButton} onclick={() => (confirmingClose = false)}>Keep editing</button>
        <button class={barButton} onclick={close}>Discard and close</button>
      </div>
    {/if}

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
