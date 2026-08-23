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
    onClose,
  }: {
    session: EditorSession;
    ctx: EditorSessionContext;
    /** `ui.editorVimMode`. Off means the surface's own key handling is all there is. */
    vimMode?: boolean;
    readonly?: boolean;
    onClose: () => void;
  } = $props();

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
      width: "min(760px, 70vw)",
      display: "flex",
      flexDirection: "column",
      zIndex: "60",
      background: "ink.white",
      borderLeft: "1px solid token(colors.neutral.border)",
      boxShadow: "-2px 0 12px rgba(0,0,0,0.06)",
    })}
    role="dialog"
    aria-label={`Editing ${session.file?.path ?? ""}`}
    onkeydown={onPanelKey}
    tabindex="-1"
  >
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
