<script lang="ts">
  import { css } from "styled-system/css";
  import { groupWarpEntries, moveHighlight, type WarpListEntry } from "$lib/warp-list";

  let {
    entries,
    /** The warp the board is already sitting on, if any: where the highlight starts. */
    focusedWarpId = null,
    readonly = false,
    onJump,
    onDelete,
    onClose,
  }: {
    entries: WarpListEntry[];
    focusedWarpId?: string | null;
    /** Read-only export: no endpoint to remove a warp with, so no remove buttons. */
    readonly?: boolean;
    onJump: (entry: WarpListEntry) => void;
    onDelete: (entry: WarpListEntry) => void;
    onClose: () => void;
  } = $props();

  let highlightedId = $state<string | null>(null);
  let panelEl: HTMLDivElement = $state()!;
  /**
   * The row buttons in the DOM, by warp id — read when the highlight moves, to scroll the
   * row into view. Recorded through an action rather than `bind:this` into a property: the
   * map is deliberately not `$state` (nothing renders from it), which is exactly what
   * `bind:this` on a member warns about, and the action's teardown drops the ids of rows
   * that have gone rather than leaving them behind to be pruned.
   */
  const rowEls: Record<string, HTMLButtonElement> = {};

  function row(node: HTMLButtonElement, id: string) {
    rowEls[id] = node;
    return {
      destroy() {
        delete rowEls[id];
      },
    };
  }

  // Rows come and go while the palette is open — removing a warp is done from here. The
  // panel takes the keyboard back whenever focus has fallen outside it: clicking a remove
  // button focuses that button, and removing the row unmounts it, which drops focus to
  // <body> — where neither this panel's handler nor the page's, held off while the palette
  // is open, would ever see another key. The same run on open is what puts the keyboard on
  // the panel in the first place, rather than on the canvas behind it.
  $effect(() => {
    // `entries` is read for the dependency alone — nothing here is computed from it. The
    // check has to run again every time a row comes or goes, not only when the panel opens.
    // oxlint-disable-next-line no-unused-expressions
    entries.length;
    if (panelEl && !panelEl.contains(document.activeElement)) panelEl.focus();
  });

  // The starting highlight, resolved against the list rather than trusted: a focused warp
  // that has since been removed would otherwise leave nothing highlighted at all.
  let highlighted = $derived(
    entries.find(({ id }) => id === highlightedId)?.id ??
      entries.find(({ id }) => id === focusedWarpId)?.id ??
      entries[0]?.id ??
      null,
  );
  let groups = $derived(groupWarpEntries(entries));

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
          class={css({ padding: "8px 10px 4px", fontSize: "11px", fontFamily: "mono", color: "ink.black" })}
        >
          {group.projectName}{group.isCurrent ? " (this project)" : ""}
        </p>
        <div role="listbox" aria-label={group.projectName}>
          {#each group.entries as entry (entry.id)}
            {@const isHighlighted = entry.id === highlighted}
            <!-- The row is two buttons side by side rather than one inside the other:
                 jumping and removing are separate targets, and a button cannot nest. -->
            <div
              role="presentation"
              class={css({ display: "flex", alignItems: "center", borderRadius: "2px" })}
              style:background={isHighlighted ? "var(--colors-select-bg)" : "transparent"}
              onmouseenter={() => (highlightedId = entry.id)}
            >
              <button
                use:row={entry.id}
                role="option"
                aria-selected={isHighlighted}
                class={css({
                  display: "flex",
                  alignItems: "baseline",
                  gap: "8px",
                  flex: "1",
                  minWidth: "0",
                  padding: "6px 10px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  color: "ink.black",
                  textAlign: "left",
                })}
                onclick={() => jump(entry)}
              >
                <span class={css({ fontFamily: "mono", fontSize: "11px", color: "neutral.secondary", flexShrink: "0" })}>
                  Warp {entry.label}
                </span>
                <span class={css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                  {entry.hint ?? ""}
                </span>
              </button>
              {#if !readonly}
                <button
                  class={css({ display: "flex", alignItems: "center", padding: "6px 10px", background: "transparent", border: "none", cursor: "pointer", color: "neutral.icon", _hover: { color: "ink.black" } })}
                  aria-label="Remove warp {entry.label} in {entry.projectName}"
                  title="Remove this warp"
                  onclick={() => onDelete(entry)}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M4.5 2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    <path d="M1.5 4h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    <path d="M2.5 4l.7 6h5.6l.7-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>
