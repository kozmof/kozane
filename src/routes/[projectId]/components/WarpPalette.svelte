<script lang="ts">
  import { css } from "styled-system/css";
  import { groupWarpEntries, moveHighlight, type WarpListEntry } from "$lib/warp-list";

  let {
    entries,
    /** The warp the board is already sitting on, if any: where the highlight starts. */
    focusedWarpId = null,
    onJump,
    onClose,
  }: {
    entries: WarpListEntry[];
    focusedWarpId?: string | null;
    onJump: (entry: WarpListEntry) => void;
    onClose: () => void;
  } = $props();

  let highlightedId = $state<string | null>(null);
  let panelEl: HTMLDivElement = $state()!;
  let rowEls: Record<string, HTMLButtonElement> = {};

  // The starting highlight, resolved against the list rather than trusted: a focused warp
  // that has since been removed would otherwise leave nothing highlighted at all.
  let highlighted = $derived(
    entries.find(({ id }) => id === highlightedId)?.id ??
      entries.find(({ id }) => id === focusedWarpId)?.id ??
      entries[0]?.id ??
      null,
  );
  let groups = $derived(groupWarpEntries(entries));

  // The palette opens under the keyboard, so it takes focus: the arrow keys have to reach
  // it rather than the canvas behind it.
  $effect(() => {
    panelEl?.focus();
  });

  $effect(() => {
    // Optional-called: jsdom has no layout, and scrolling a list is not worth a crash.
    if (highlighted) rowEls[highlighted]?.scrollIntoView?.({ block: "nearest" });
  });

  function move(delta: -1 | 1) {
    highlightedId = moveHighlight(entries, highlighted, delta)?.id ?? null;
  }

  function jump(entry: WarpListEntry) {
    highlightedId = entry.id;
    onJump(entry);
  }

  function handleKeydown(e: KeyboardEvent) {
    // Nothing typed at the palette is meant for the board behind it — and without this the
    // shift+arrow that closes the palette would reach the page and open it straight again.
    e.stopPropagation();
    // Shift+arrow is the key that opened the palette, so it closes it again.
    if (e.shiftKey && e.key.startsWith("Arrow")) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries.find(({ id }) => id === highlighted);
      if (entry) jump(entry);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }
</script>

<!-- The backdrop closes on a click, the way the composer's popovers do. -->
<div
  class={css({
    position: "fixed",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.12)",
    zIndex: "300",
  })}
  role="presentation"
  onmousedown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    bind:this={panelEl}
    role="dialog"
    aria-modal="true"
    aria-label="Warps"
    tabindex="-1"
    onkeydown={handleKeydown}
    class={css({
      width: "min(440px, calc(100vw - 32px))",
      maxHeight: "min(60vh, 520px)",
      overflowY: "auto",
      background: "ink.white",
      border: "1px solid token(colors.neutral.border)",
      borderRadius: "4px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.08)",
      padding: "6px",
      outline: "none",
    })}
  >
    {#if entries.length === 0}
      <p class={css({ padding: "16px", fontSize: "12px", color: "neutral.subtle", textAlign: "center" })}>
        No warps yet. Press the set-warp key on any board to make one.
      </p>
    {:else}
      {#each groups as group (group.projectId)}
        <p
          class={css({ padding: "8px 10px 4px", fontSize: "11px", fontFamily: "mono", color: "neutral.muted" })}
        >
          {group.projectName}{group.isCurrent ? " (this project)" : ""}
        </p>
        <div role="listbox" aria-label={group.projectName}>
          {#each group.entries as entry (entry.id)}
            {@const isHighlighted = entry.id === highlighted}
            <button
              bind:this={rowEls[entry.id]}
              role="option"
              aria-selected={isHighlighted}
              class={css({
                display: "flex",
                alignItems: "baseline",
                gap: "8px",
                width: "100%",
                padding: "6px 10px",
                border: "none",
                borderRadius: "2px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "12px",
                color: "ink.black",
                textAlign: "left",
              })}
              style:background={isHighlighted ? "var(--colors-select-bg)" : "transparent"}
              onmouseenter={() => (highlightedId = entry.id)}
              onclick={() => jump(entry)}
            >
              <span class={css({ fontFamily: "mono", fontSize: "11px", color: "neutral.secondary", flexShrink: "0" })}>
                Warp {entry.label}
              </span>
              <span class={css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                {entry.hint ?? ""}
              </span>
              <span class={css({ fontFamily: "mono", fontSize: "10px", color: "neutral.subtle", flexShrink: "0" })}>
                {entry.posX}, {entry.posY}
              </span>
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
