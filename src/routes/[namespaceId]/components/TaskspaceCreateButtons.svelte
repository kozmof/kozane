<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { TaskspaceCreateKind } from "../lib/taskspace-tree.svelte.js";

  let {
    where,
    onCreate,
  }: {
    /** What the new entry goes into, for the titles: "this folder", "this taskspace". */
    where: string;
    onCreate: (kind: TaskspaceCreateKind) => void;
  } = $props();

  // Shared with the refresh control beside it in the scope panel, which fades in on the
  // same hover: `hover-reveal` is what the containing row's rule looks for.
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
    // Reachable by keyboard: without this the controls are focusable but invisible, and
    // tabbing through the panel lands on a button nothing on screen accounts for.
    "&:focus-visible": { opacity: "1" },
  });
</script>

<!-- A page with a corner turned up, and a folder, each with the same plus at its lower
     right: the pair reads as one set of controls at 11px, where a label would not fit and
     two unrelated glyphs would not group. -->
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
