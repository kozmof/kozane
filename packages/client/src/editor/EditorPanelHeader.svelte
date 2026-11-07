<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { EditorSession } from "./editor-session.svelte.js";
  import { barButton, iconButton, pinnedButton } from "./panel-styles.js";

  /** The editor panel's header: the file's place, its unsaved marker, and the panel buttons. */
  let {
    session,
    readonly,
    pinned = $bindable(),
    onSave,
    onClose,
  }: {
    session: EditorSession;
    readonly: boolean;
    pinned: boolean;
    onSave: () => void;
    onClose: () => void;
  } = $props();
</script>

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
      onclick={onSave}
      disabled={session.saving || !session.dirty || session.loading}
    >
      {session.saving ? "Saving…" : "Save"}
    </button>
  {/if}
  <button class={barButton} onclick={onClose}>Close</button>
</div>
