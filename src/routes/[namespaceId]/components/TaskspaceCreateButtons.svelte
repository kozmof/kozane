<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { TaskspaceCreateKind } from "../lib/taskspace-tree.svelte.js";

  let {
    where,
    onCreate,
  }: {
    /** Destination label used in titles, such as "this folder" or "this taskspace". */
    where: string;
    onCreate: (kind: TaskspaceCreateKind) => void;
  } = $props();

  // Share `hover-reveal` with the refresh control so the containing row reveals both
  // together.
  const btnClass = css({
    width: "20px",
    height: "20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    background: "none",
    border: "none",
    cursor: "pointer",
    borderRadius: "2px",
    color: "neutral.subtle",
    opacity: "0",
    transition: "opacity 0.12s, color 0.12s",
    "&:hover": { color: "ink.black" },
    // Reveal controls on keyboard focus so tabbing never lands on an invisible button.
    "&:focus-visible": { opacity: "1" },
  });
</script>

<!-- Use page and folder glyphs with matching plus signs to group the creation controls at their small display size. -->
{#snippet newFileIcon()}
  <svg width="13" height="13" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 1h2.8l1.7 1.7V5.4" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" />
    <path d="M2 1v8h2.4" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" />
    <path d="M7.2 6v3.2M5.6 7.6h3.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
  </svg>
{/snippet}

{#snippet newFolderIcon()}
  <svg width="13" height="13" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M1 8.4V2.2h2.5l.9 1.1H8.2V5.4" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" />
    <path d="M1 8.4h3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
    <path d="M7.2 6v3.2M5.6 7.6h3.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
  </svg>
{/snippet}

<button
  class={cx("hover-reveal", btnClass)}
  title={`New file in ${where}`}
  aria-label={`New file in ${where}`}
  onclick={(e) => { e.stopPropagation(); onCreate("file"); }}
>{@render newFileIcon()}</button>
<button
  class={cx("hover-reveal", btnClass)}
  title={`New folder in ${where}`}
  aria-label={`New folder in ${where}`}
  onclick={(e) => { e.stopPropagation(); onCreate("directory"); }}
>{@render newFolderIcon()}</button>
