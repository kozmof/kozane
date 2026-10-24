<script lang="ts">
  import { css, cx } from "styled-system/css";
  import { beforeNavigate } from "$app/navigation";
  import EditorSurface, { type EditorMode } from "./EditorSurface.svelte";
  import type {
    EditorSession,
    EditorSessionContext,
  } from "../lib/editor/editor-session.svelte.js";
  import type { EditorDocument } from "../lib/editor/document-store.svelte.js";
  import { createVimState, handleVimKey, type VimState } from "../lib/editor/vim.js";
  import { guardUnsavedLeave, UNSAVED_LEAVE_PROMPT } from "../lib/editor/leave-guard.js";

  let {
    session,
    ctx,
    vimMode = false,
    autoSave = false,
    readonly = false,
    width = $bindable(null),
    pinned = $bindable(false),
    onClose,
  }: {
    session: EditorSession;
    ctx: EditorSessionContext;
    /** `ui.editorVimMode`. Off means the surface's own key handling is all there is. */
    vimMode?: boolean;
    /** `ui.editorAutoSave`. Saves once typing pauses, and on close. Ignored when read-only. */
    autoSave?: boolean;
    readonly?: boolean;
    /**
     * Panel width in pixels, or null for the responsive default. The page owns this value so
     * it survives closing or remounting the editor.
     */
    width?: number | null;
    /**
     * Whether the panel stays open when the user presses outside it. Escape and Close still
     * close it. The page owns this value, like `width`, so it survives closing a file.
     */
    pinned?: boolean;
    onClose: () => void;
  } = $props();

  /** Panel width limits that leave room for readable text and the board. */
  const MIN_WIDTH = 320;
  const EDGE_MARGIN = 120;
  const KEY_STEP = 16;
  /** Pause after the last edit before auto save writes the file. */
  const AUTO_SAVE_DELAY_MS = 1000;

  let panelEl: HTMLDivElement | undefined = $state();
  let surface: { focus: () => void } | undefined = $state();
  let vim = $state<VimState>(createVimState());

  const mode = $derived<EditorMode>(vimMode ? vim.mode : "insert");

  // Keep keyboard events within the open editor so typing cannot trigger board shortcuts.
  $effect(() => {
    if (session.isOpen && panelEl && !panelEl.contains(document.activeElement)) surface?.focus();
  });

  // Reset Vim to normal mode and clear the close prompt when opening a different file.
  $effect(() => {
    void session.file;
    vim = createVimState();
    confirmingClose = false;
  });

  /**
   * Close on a press outside the panel, unless pinned. Use `mousedown` so dragging a text
   * selection beyond the panel does not close the file.
   */
  $effect(() => {
    if (!session.isOpen || pinned) return;
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

  const autoSaving = $derived(autoSave && !readonly);

  /**
   * Text auto save watches. Keyed on the text rather than `doc.state`, because Reed's
   * background reconciliation replaces the state without an edit.
   */
  const draft = $derived(autoSaving ? (session.doc?.text() ?? null) : null);

  /**
   * Text whose auto save failed, and the document it belongs to. Retry only after another
   * edit so a failing server is not asked again every second. A conflict waits for a reload
   * instead. Another file, or the same file reopened, starts afresh.
   */
  let failedDraft = $state.raw<{ doc: EditorDocument; text: string } | null>(null);

  // Save once edits pause. Each edit changes `draft`, which restarts the timer. A save in
  // flight blocks scheduling, and edits made during it reschedule when it finishes.
  $effect(() => {
    const text = draft;
    const doc = session.doc;
    if (text === null || !doc) return;
    if (failedDraft?.doc === doc && failedDraft.text === text) return;
    if (!session.dirty || session.saving || session.conflict) return;
    const timer = setTimeout(async () => {
      // A save on close may have started since. This effect runs again when it finishes.
      if (session.saving) return;
      // A failure only counts against the document still open, not one closed meanwhile.
      if (!(await session.save(ctx)) && session.doc === doc) failedDraft = { doc, text };
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });

  /**
   * Whether closing is awaiting confirmation for unsaved changes. Keep the document open
   * until the user saves or discards those changes.
   */
  let confirmingClose = $state(false);

  /** Request closing, prompting first when the file has unsaved changes. */
  function requestClose(): void {
    if (!session.dirty) close();
    else if (autoSaving) void saveAndClose();
    else confirmingClose = true;
  }

  /** Whether a save on close is running, so a second close request does not start another. */
  let savingToClose = false;

  /** Save pending edits before closing. Ask as usual when the save fails. */
  async function saveAndClose(): Promise<void> {
    if (savingToClose) return;
    savingToClose = true;
    try {
      await saveThenClose();
    } finally {
      savingToClose = false;
    }
  }

  async function saveThenClose(): Promise<void> {
    const file = session.file;
    // An auto save may already be writing. Wait for it, then save whatever it did not cover.
    // After a conflict, saving again is refused too, so ask straight away.
    await session.settled();
    const saved =
      session.file === file &&
      (!session.dirty || (!session.conflict && (await session.save(ctx))));
    // Leave a file that was replaced or closed while saving alone.
    if (session.file !== file) return;
    if (saved && !session.dirty) close();
    else confirmingClose = true;
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
   * Clamp the rendered panel width to the viewport while preserving the requested width.
   * Restore that width when the viewport has room again.
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
    // Prevent resizing from selecting text or moving focus.
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

  /**
   * The pin holds only an icon, shorter than the text buttons' line box. Stretch it to the
   * header row, whose height those buttons set, and center the icon.
   */
  const iconButton = css({ alignSelf: "stretch", display: "inline-flex", alignItems: "center" });
  const pinnedButton = css({ color: "select.accent", borderColor: "select.accent" });
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
      <button
        class={cx(barButton, iconButton, pinned && pinnedButton)}
        onclick={() => (pinned = !pinned)}
        aria-pressed={pinned}
        aria-label="Pin editor"
        title={pinned ? "Unpin: close on a click outside" : "Pin: stay open on a click outside"}
        data-testid="editor-pin"
      >
        <!-- A pushpin, upright when pinned and tilted when not. -->
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill={pinned ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
          aria-hidden="true"
          style:display="block"
          style:transform={pinned ? null : "rotate(45deg)"}
        >
          <path d="M5 1.5h6M6 1.5v5L3.5 9.5h9L10 6.5v-5M8 9.5v5" />
        </svg>
      </button>
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
