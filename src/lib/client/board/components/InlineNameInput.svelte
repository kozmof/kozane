<script lang="ts">
  import { css } from "styled-system/css";

  let {
    value: initial = "",
    label,
    indent = 8,
    onSubmit,
    onCancel,
  }: {
    /** The current name when renaming. Empty when creating. */
    value?: string;
    /** Placeholder and accessible name, such as "New scope name". */
    label: string;
    /** Left padding in pixels, so the field lines up with the rows around it. */
    indent?: number;
    /** Resolve to the reason the name was refused, or null when it was accepted. */
    onSubmit: (name: string) => Promise<string | null>;
    /** Close the field. A blur passes where focus is going, or null. */
    onCancel: (focusTo?: EventTarget | null) => void;
  } = $props();

  // Seeded once. Later changes to the row's name do not overwrite what is being typed.
  // svelte-ignore state_referenced_locally
  let value = $state(initial);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!input) return;
    input.focus();
    // Select the stem of a file name, so typing replaces the name and keeps the extension.
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  });

  async function submit(): Promise<void> {
    if (busy) return;
    if (value.trim() === initial.trim() && initial !== "") {
      onCancel();
      return;
    }
    busy = true;
    try {
      error = await onSubmit(value);
    } catch {
      error = "Something went wrong. Try again.";
    } finally {
      // Never leave the field refusing Enter after a failure.
      busy = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // Keep typed characters away from the modal's navigation and the board's shortcuts.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const rowClass = css({ display: "flex", alignItems: "center", padding: "2px 6px" });
  const inputClass = css({
    flex: "1",
    minWidth: "0",
    padding: "3px 6px",
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

<!-- Cancel on blur, so clicking elsewhere in the modal abandons the edit. -->
<div class={rowClass} style:padding-left={`${indent}px`}>
  <input
    bind:this={input}
    bind:value
    class={inputClass}
    type="text"
    readonly={busy}
    placeholder={label}
    aria-label={label}
    aria-invalid={error !== null}
    onkeydown={onKeydown}
    onblur={(e) => !busy && onCancel(e.relatedTarget)}
  />
</div>
{#if error}
  <div class={errorClass} style:padding-left={`${indent}px`} role="alert">{error}</div>
{/if}
