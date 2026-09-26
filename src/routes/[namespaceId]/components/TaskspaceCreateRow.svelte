<script lang="ts">
  import { css } from "styled-system/css";
  import type { TaskspaceCreateKind } from "../lib/taskspace-tree.svelte.js";

  let {
    kind,
    indent,
    busy = false,
    error = null,
    onSubmit,
    onCancel,
  }: {
    kind: TaskspaceCreateKind;
    /** Left padding in pixels, so the field lines up with the rows it will join. */
    indent: number;
    busy?: boolean;
    error?: string | null;
    onSubmit: (name: string) => void;
    onCancel: () => void;
  } = $props();

  let value = $state("");
  let input: HTMLInputElement | undefined = $state();

  // The field appears because someone asked for it, so it takes the keyboard without a
  // second click. `$effect` rather than `autofocus`, which only applies on page load.
  $effect(() => {
    input?.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    // Kept off the board behind the panel, which otherwise reads single keys as shortcuts.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    width: "100%",
    padding: "2px 6px",
  });
  const inputClass = css({
    flex: "1",
    minWidth: "0",
    padding: "2px 5px",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "2px",
    background: "ink.white",
    color: "ink.black",
    fontSize: "11.5px",
    fontFamily: "inherit",
    "&:read-only": { color: "neutral.subtle" },
  });
  const errorClass = css({ padding: "1px 6px 3px", fontSize: "11px", color: "state.error" });
</script>

<!-- A press elsewhere in the tree puts the name away. Left to the input's own `blur` rather
     than a document listener, so that the button that opened it can take the click that
     closes the one before it. -->
<div class={rowClass} style:padding-left={`${indent}px`}>
  <input
    bind:this={input}
    bind:value
    class={inputClass}
    type="text"
    readonly={busy}
    placeholder={kind === "file" ? "New file name" : "New folder name"}
    aria-label={kind === "file" ? "New file name" : "New folder name"}
    onkeydown={onKeydown}
    onblur={() => !busy && onCancel()}
  />
</div>
{#if error}
  <div class={errorClass} style:padding-left={`${indent}px`} role="alert">{error}</div>
{/if}
