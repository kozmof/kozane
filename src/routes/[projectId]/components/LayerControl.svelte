<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { CardWithGlue, Layer } from "$lib/types";
  import {
    insideTriangle,
    orderLayers,
    reorderByDrop,
    reorderByNudge,
    safeTriangle,
    SAFE_AREA_GRACE_MS,
    type Triangle,
  } from "../lib/project-page.js";

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
  let panelEl: HTMLDivElement | null = $state(null);
  let safeArea = $state<Triangle | null>(null);
  let draggingId = $state<string | null>(null);
  let dropTargetId = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");

  const open = $derived(hovering || pinned);
  // Topmost first, so the popover reads the way the canvas stacks.
  const ordered = $derived(orderLayers(layers).reverse());
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

  function close() {
    hovering = false;
    safeArea = null;
  }

  /**
   * The pointer left the control while the popover was open. Rather than closing on the
   * spot, watch where it goes: inside the corridor towards the popover it is still on its
   * way in, and anywhere else it has left for good. The grace timer is the other half of
   * that — a pointer parked in the corridor is not travelling anywhere.
   */
  $effect(() => {
    if (!safeArea) return;
    const corridor = safeArea;
    function handleMove(e: MouseEvent) {
      if (!insideTriangle({ x: e.clientX, y: e.clientY }, corridor)) close();
    }
    const giveUp = setTimeout(close, SAFE_AREA_GRACE_MS);
    document.addEventListener("mousemove", handleMove);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      clearTimeout(giveUp);
    };
  });

  function leaveControl(e: MouseEvent) {
    // Nothing to aim at with the popover shut, and a pinned one is not ours to close.
    if (!open || pinned || !panelEl) {
      close();
      return;
    }
    safeArea = safeTriangle({ x: e.clientX, y: e.clientY }, panelEl.getBoundingClientRect());
  }

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

  /** The popover lists layers top first; the callback wants them bottom to top. */
  function commitDisplayOrder(displayIds: string[]) {
    onReorderLayers([...displayIds].reverse());
  }

  function dropOn(targetId: string) {
    // A drop on the row being dragged changes nothing and is not worth a request.
    if (draggingId && draggingId !== targetId) {
      commitDisplayOrder(reorderByDrop(ordered.map(({ id }) => id), draggingId, targetId));
    }
    draggingId = null;
    dropTargetId = null;
  }

  /** Keyboard equivalent of a drag: `delta` is -1 for up the list, 1 for down. */
  function nudge(layerId: string, delta: -1 | 1) {
    const reordered = reorderByNudge(ordered.map(({ id }) => id), layerId, delta);
    if (reordered) commitDisplayOrder(reordered);
  }

  const listClass = css({ listStyle: "none", margin: "0", padding: "0" });

  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 10px",
    borderRadius: "2px",
    background: "transparent",
    // The handle and × stay out of the way until the row is under the pointer.
    "&:hover .layer-delete, &:hover .layer-handle": { opacity: "1" },
    "& .layer-delete:focus-visible, & .layer-handle:focus-visible": { opacity: "1" },
  });

  // Selecting the layer is a real button rather than the row itself, so that the reorder
  // handle and the × are its siblings instead of its descendants. See the note on the list.
  const selectClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flex: "1",
    minWidth: "0",
    padding: "0",
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
    color: "ink.black",
    textAlign: "left",
    background: "transparent",
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
  onmouseenter={() => {
    hovering = true;
    // Arrived: whatever corridor was being watched has served its purpose.
    safeArea = null;
  }}
  onmouseleave={leaveControl}
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
    <!-- The panel hangs off a wrapper that starts flush with the button, so a pointer
         moving straight down never leaves the hover area. The diagonal is the safe
         triangle's job, since the panel is wider than the button it hangs from. -->
    <div class={css({ position: "absolute", top: "100%", right: "0", paddingTop: "6px" })}>
    <div
      bind:this={panelEl}
      class={css({
        background: "ink.white",
        border: "1px solid token(colors.neutral.border)",
        borderRadius: "2px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.03)",
        padding: "4px",
        minWidth: "180px",
      })}
    >
      <!-- A plain list rather than a listbox: every row carries its own reorder handle, ×,
           and rename field, and ARIA forbids interactive descendants inside an option — a
           screen reader would never reach them. Selecting the layer is the name button
           below, which reports its own state with aria-pressed. -->
      <ul class={listClass} aria-label="Layers">
        {#each ordered as layer (layer.id)}
          {@const isActive = layer.id === activeLayerId}
          {@const isRenaming = renamingId === layer.id}
          <!-- Dragging the row reorders the stack; a click on the name selects, and a
               double-click on it renames. -->
          <li
            class={cx(
              rowClass,
              isActive && activeRowClass,
              dropTargetId === layer.id && dropTargetClass,
              draggingId === layer.id && draggingRowClass,
            )}
            data-layer-row={layer.id}
            draggable={!readonly && !isRenaming}
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
                onkeydown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
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
                onblur={commitRename}
                onkeydown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") renamingId = null;
                }}
              />
            {:else}
              <!-- A button, so Enter and Space select without a hand-written key handler,
                   and the pressed state is announced. -->
              <button
                class={selectClass}
                aria-pressed={isActive}
                onclick={() => (activeLayerId = layer.id)}
                ondblclick={() => startRename(layer)}
                onkeydown={(e) => {
                  if (e.key !== "F2") return;
                  e.preventDefault();
                  startRename(layer);
                }}
              >
                <span class={css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                  {layer.name}
                </span>
                <span class={css({ fontSize: "10.5px", color: "neutral.subtle", flexShrink: "0" })}>
                  {cardCount.get(layer.id) ?? 0}
                </span>
                {#if isActive}
                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none" class={css({ flexShrink: "0" })} aria-hidden="true">
                    <path d="M1 4l3 3 5-6" stroke="var(--colors-ink-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                {/if}
              </button>
              {#if !layer.isDefault && !readonly}
                <button
                  class={cx("layer-delete", deleteClass)}
                  title="Delete layer"
                  aria-label="Delete {layer.name}"
                  onclick={() => onDeleteLayer(layer.id)}
                >×</button>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>

      {#if !readonly}
        <div class={css({ marginTop: "4px", paddingTop: "4px", borderTop: "1px solid token(colors.neutral.dim)", display: "flex", gap: "4px" })}>
          <input
            class={css({ flex: "1", minWidth: "0", padding: "5px 8px", border: "1px solid token(colors.neutral.dim)", borderRadius: "2px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
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
