<script lang="ts">
  import { css } from "styled-system/css";
  import type {
    EditorSession,
    EditorSessionContext,
  } from "./editor-session.svelte.js";
  import { barButton } from "./panel-styles.js";

  /**
   * Notices under the editor's header: the unsaved-changes question while closing, then a
   * conflict with the file on disk or a save error.
   */
  let {
    session,
    ctx,
    confirmingClose = $bindable(),
    onDiscard,
  }: {
    session: EditorSession;
    ctx: EditorSessionContext;
    confirmingClose: boolean;
    onDiscard: () => void;
  } = $props();
</script>

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
    <button class={barButton} onclick={onDiscard}>Discard and close</button>
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
