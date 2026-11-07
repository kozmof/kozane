<script lang="ts">
  import { css, cx } from "../styles/css.js";
  import type { EditorSession } from "./editor-session.svelte.js";
  import type { VimState } from "./vim.js";

  /** The editor's status bar: the Vim mode and pending keys, line count, and caret place. */
  let { session, vimMode, vim }: { session: EditorSession; vimMode: boolean; vim: VimState } =
    $props();
</script>

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
