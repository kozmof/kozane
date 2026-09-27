<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope } from "$lib/types";

  let {
    scopes,
    cardCount,
    onChoose,
    onCreate,
    onCancel,
  }: {
    /** Already narrowed to this namespace by the snapshot, the same list the panel gets. */
    scopes: Scope[];
    /** How many cards the drawn rectangle covers, so the choice is made knowing the cost. */
    cardCount: number;
    onChoose: (scopeId: string) => void;
    onCreate: (name: string) => void;
    onCancel: () => void;
  } = $props();

  let newName = $state("");
  let inputEl: HTMLInputElement | undefined = $state();

  // Every scope, including ones already framed here: a scope may be organised in several
  // places on one board, and framing it again is the ordinary way to say so.
  const available = $derived(scopes);

  export function focusInput() {
    inputEl?.focus();
  }

  $effect(() => {
    inputEl?.focus();
  });

  function submit() {
    const name = newName.trim();
    if (!name) return;
    newName = "";
    onCreate(name);
  }

  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    fontFamily: "inherit",
    color: "ink.black",
    whiteSpace: "nowrap",
    overflow: "hidden",
    "&:hover": { backgroundColor: "neutral.bg" },
  });
</script>

<!--
  Anchored to the bottom of the viewport rather than to the rectangle: the rectangle is in
  world space, so a panel pinned to it would have to be re-placed on every pan and zoom, and
  would sit off screen the moment either moved. The board already answers a question this way
  — the composer sits here too — and the rectangle stays drawn behind it, which is what says
  which rectangle is being asked about.
-->
<div
  class={css({
    position: "absolute",
    bottom: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "320px",
    maxWidth: "calc(100% - 40px)",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.neutral.border)",
    borderRadius: "3px",
    boxShadow: "0 1px 10px rgba(0,0,0,0.06)",
    zIndex: "60",
    overflow: "hidden",
  })}
  role="dialog"
  aria-label="Choose a scope for the new frame"
  tabindex="-1"
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  }}
>
  <div
    class={css({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      padding: "7px 10px",
      borderBottom: "1px solid token(colors.neutral.dim)",
      fontSize: "11px",
      color: "neutral.secondary",
    })}
  >
    <span>Frame {cardCount} {cardCount === 1 ? "card" : "cards"} as</span>
    <button
      class={css({
        background: "none",
        border: "none",
        cursor: "pointer",
        fontSize: "13px",
        color: "neutral.subtle",
        "&:hover": { color: "state.error" },
      })}
      aria-label="Cancel frame"
      onclick={onCancel}>×</button
    >
  </div>

  {#if available.length > 0}
    <div
      class={css({
        maxHeight: "180px",
        overflowY: "auto",
        padding: "4px",
        display: "flex",
        flexDirection: "column",
        gap: "1px",
      })}
    >
      {#each available as scope (scope.id)}
        <button class={rowClass} onclick={() => onChoose(scope.id)}>{scope.name}</button>
      {/each}
    </div>
  {/if}

  <form
    class={cx(
      css({
        display: "flex",
        gap: "6px",
        padding: "6px",
        borderTop: available.length > 0 ? "1px solid token(colors.neutral.dim)" : "none",
      }),
    )}
    onsubmit={(e) => {
      e.preventDefault();
      submit();
    }}
  >
    <input
      bind:this={inputEl}
      bind:value={newName}
      class={css({
        flex: "1",
        minWidth: "0",
        padding: "5px 8px",
        border: "1px solid token(colors.neutral.border)",
        borderRadius: "2px",
        fontSize: "12px",
        fontFamily: "inherit",
      })}
      placeholder="New scope name"
      aria-label="New scope name"
    />
    <button
      class={css({
        padding: "5px 10px",
        backgroundColor: "ink.black",
        color: "ink.light",
        border: "none",
        borderRadius: "2px",
        cursor: "pointer",
        fontSize: "12px",
        fontFamily: "inherit",
      })}
      type="submit">+</button
    >
  </form>
</div>
