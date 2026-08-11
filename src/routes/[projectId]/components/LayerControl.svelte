<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { CardWithGlue, Layer } from "$lib/types";

  let {
    layers,
    cards,
    activeLayerId = $bindable(),
    onCreateLayer,
    onDeleteLayer,
    onRenameLayer,
    onReorderLayers,
    readonly = false,
  }: {
    layers: Layer[];
    cards: CardWithGlue[];
    activeLayerId: string | null;
    onCreateLayer: (name: string) => void;
    onDeleteLayer: (layerId: string) => void;
    onRenameLayer: (layerId: string, name: string) => void;
    /** Receives the project's full layer ordering, bottom to top. */
    onReorderLayers: (layerIds: string[]) => void;
    // Read-only export: keep layer selection, hide create/delete/reorder controls.
    readonly?: boolean;
  } = $props();

  let hovering = $state(false);
  let pinned = $state(false);
  let newLayerName = $state("");
  let controlEl: HTMLDivElement = $state()!;
  let draggingId = $state<string | null>(null);
  let dropTargetId = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");

  const open = $derived(hovering || pinned);
  // Topmost first, so the popover reads the way the canvas stacks.
  const ordered = $derived(
    [...layers].sort((a, b) => b.position - a.position || b.id.localeCompare(a.id)),
  );
  const cardCount = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const card of cards) counts.set(card.layerId, (counts.get(card.layerId) ?? 0) + 1);
    return counts;
  });

  // A pinned popover stays open until a click lands outside it, the same way the
  // bundle dropdown in the composer behaves.
  $effect(() => {
    if (!pinned) return;
    function handleDown(e: MouseEvent) {
      if (!controlEl?.contains(e.target as Node)) {
        pinned = false;
        hovering = false;
      }
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  });

  function create() {
    const name = newLayerName.trim();
    if (!name) return;
    onCreateLayer(name);
    newLayerName = "";
  }

  function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function startRename(layer: Layer) {
    if (readonly) return;
    renamingId = layer.id;
    renameValue = layer.name;
  }

  function commitRename() {
    if (!renamingId) return;
    onRenameLayer(renamingId, renameValue);
    renamingId = null;
  }

  function moveWithin(ids: string[], layerId: string, toIndex: number): string[] {
    const next = [...ids];
    const [moved] = next.splice(next.indexOf(layerId), 1);
    next.splice(toIndex, 0, moved);
    return next;
  }

  /** The popover lists layers top first; the callback wants them bottom to top. */
  function commitDisplayOrder(displayIds: string[]) {
    onReorderLayers([...displayIds].reverse());
  }

  function dropOn(targetId: string) {
    const displayIds = ordered.map(({ id }) => id);
    if (draggingId && draggingId !== targetId) {
      commitDisplayOrder(moveWithin(displayIds, draggingId, displayIds.indexOf(targetId)));
    }
    draggingId = null;
    dropTargetId = null;
  }

  /** Keyboard equivalent of a drag: `delta` is -1 for up the list, 1 for down. */
  function nudge(layerId: string, delta: -1 | 1) {
    const displayIds = ordered.map(({ id }) => id);
    const target = displayIds.indexOf(layerId) + delta;
    if (target < 0 || target >= displayIds.length) return;
    commitDisplayOrder(moveWithin(displayIds, layerId, target));
  }

  const rowClass = css({
    display: "flex",
    alignItems: "center",
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
    background: "transparent",
    // The handle and × stay out of the way until the row is under the pointer.
    "&:hover .layer-delete, &:hover .layer-handle": { opacity: "1" },
    "& .layer-delete:focus-visible, & .layer-handle:focus-visible": { opacity: "1" },
  });
  const activeRowClass = css({ backgroundColor: "neutral.bg" });
  const draggingRowClass = css({ opacity: "0.4" });
  const dropTargetClass = css({ boxShadow: "inset 0 0 0 1px token(colors.select.accent)" });

  const iconButtonClass = {
    width: "16px",
    height: "18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    borderRadius: "2px",
    flexShrink: "0",
    opacity: "0",
    transition: "opacity 0.12s, color 0.12s",
  } as const;

  const handleClass = css({
    ...iconButtonClass,
    cursor: "grab",
    color: "neutral.subtle",
    marginLeft: "-4px",
    "&:hover": { color: "ink.black" },
  });
  const deleteClass = css({
    ...iconButtonClass,
    cursor: "pointer",
    fontSize: "13px",
    color: "neutral.subtle",
    "&:hover": { color: "state.error" },
  });
</script>

<div
  bind:this={controlEl}
  class={css({ position: "absolute", top: "12px", right: "52px", zIndex: "51" })}
  role="presentation"
  onmouseenter={() => (hovering = true)}
  onmouseleave={() => (hovering = false)}
  onfocusin={() => (hovering = true)}
  onfocusout={(e) => {
    // Keyboard users open the popover by focusing it, so it has to close again when
    // focus moves out of the control entirely rather than between its own buttons.
    if (!controlEl.contains(e.relatedTarget as Node | null)) hovering = false;
  }}
>
  <button
    class={css({
      width: "28px",
      height: "28px",
      borderRadius: "2px",
      backgroundColor: "ink.light",
      border: "1px solid token(colors.neutral.border)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 1px 3px rgba(0,0,0,0.018)",
    })}
    title="Layers"
    aria-label="Layers"
    aria-expanded={open}
    aria-haspopup="listbox"
    onclick={() => (pinned = !pinned)}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1.5L12.5 4.5L7 7.5L1.5 4.5L7 1.5Z" stroke="var(--colors-neutral-icon)" stroke-width="1.1" stroke-linejoin="round" />
      <path d="M2 7L7 9.75L12 7" stroke="var(--colors-neutral-subtle)" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M2 9.5L7 12.25L12 9.5" stroke="var(--colors-neutral-subtle)" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <!-- The panel hangs off a wrapper that starts flush with the button, so moving the
         pointer from the button into the popover never leaves the hover area. -->
    <div class={css({ position: "absolute", top: "100%", right: "0", paddingTop: "6px" })}>
    <div
      class={css({
        background: "ink.white",
        border: "1px solid token(colors.neutral.border)",
        borderRadius: "2px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.03)",
        padding: "4px",
        minWidth: "180px",
      })}
    >
      <div role="listbox" aria-label="Layers">
        {#each ordered as layer (layer.id)}
          {@const isActive = layer.id === activeLayerId}
          {@const isRenaming = renamingId === layer.id}
          <!-- The row itself is the option: a click selects, a double-click renames,
               and dragging it reorders the stack. -->
          <div
            class={cx(
              rowClass,
              isActive && activeRowClass,
              dropTargetId === layer.id && dropTargetClass,
              draggingId === layer.id && draggingRowClass,
            )}
            role="option"
            aria-selected={isActive}
            tabindex="0"
            data-layer-row={layer.id}
            draggable={!readonly && !isRenaming}
            onclick={() => (activeLayerId = layer.id)}
            ondblclick={() => startRename(layer)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activeLayerId = layer.id;
              } else if (e.key === "F2") {
                e.preventDefault();
                startRename(layer);
              }
            }}
            ondragstart={(e) => {
              draggingId = layer.id;
              e.dataTransfer?.setData("text/plain", layer.id);
            }}
            ondragover={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              dropTargetId = layer.id;
            }}
            ondragleave={() => {
              if (dropTargetId === layer.id) dropTargetId = null;
            }}
            ondrop={(e) => {
              e.preventDefault();
              dropOn(layer.id);
            }}
            ondragend={() => {
              draggingId = null;
              dropTargetId = null;
            }}
          >
            {#if !readonly}
              <button
                class={cx("layer-handle", handleClass)}
                title="Drag to reorder, or use the arrow keys"
                aria-label="Reorder {layer.name}"
                onclick={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onkeydown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
                  e.stopPropagation();
                  nudge(layer.id, e.key === "ArrowUp" ? -1 : 1);
                }}
              >
                <svg width="8" height="10" viewBox="0 0 8 10" fill="none" aria-hidden="true">
                  {#each [1, 5, 9] as y (y)}
                    <circle cx="1.5" cy={y - 0.5} r="0.9" fill="currentColor" />
                    <circle cx="6.5" cy={y - 0.5} r="0.9" fill="currentColor" />
                  {/each}
                </svg>
              </button>
            {/if}

            {#if isRenaming}
              <input
                class={css({ flex: "1", minWidth: "0", padding: "2px 4px", border: "1px solid token(colors.select.accent)", borderRadius: "2px", fontSize: "12px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
                aria-label="Rename {layer.name}"
                bind:value={renameValue}
                use:autofocus
                onclick={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onblur={commitRename}
                onkeydown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") renamingId = null;
                }}
              />
            {:else}
              <span class={css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                {layer.name}
              </span>
              <span class={css({ fontSize: "10.5px", color: "neutral.subtle", flexShrink: "0" })}>
                {cardCount.get(layer.id) ?? 0}
              </span>
              {#if isActive}
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none" class={css({ flexShrink: "0" })}>
                  <path d="M1 4l3 3 5-6" stroke="var(--colors-ink-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              {/if}
              {#if !layer.isDefault && !readonly}
                <button
                  class={cx("layer-delete", deleteClass)}
                  title="Delete layer"
                  aria-label="Delete {layer.name}"
                  onclick={(e) => { e.stopPropagation(); onDeleteLayer(layer.id); }}
                  ondblclick={(e) => e.stopPropagation()}
                >×</button>
              {/if}
            {/if}
          </div>
        {/each}
      </div>

      {#if !readonly}
        <div class={css({ marginTop: "4px", paddingTop: "4px", borderTop: "1px solid token(colors.neutral.dim)", display: "flex", gap: "4px" })}>
          <input
            class={css({ flex: "1", minWidth: "0", padding: "5px 8px", border: "1px solid token(colors.neutral.dim)", borderRadius: "2px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
            placeholder="New layer"
            aria-label="New layer name"
            bind:value={newLayerName}
            onkeydown={(e) => e.key === "Enter" && create()}
          />
          <button
            class={css({ padding: "5px 9px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "2px", cursor: "pointer", fontSize: "13px", fontFamily: "inherit", lineHeight: "1" })}
            title="Add layer"
            aria-label="Add layer"
            onclick={create}
          >+</button>
        </div>
      {/if}
    </div>
    </div>
  {/if}
</div>
