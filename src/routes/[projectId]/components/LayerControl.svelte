<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { CardWithGlue, Layer } from "$lib/types";

  let {
    layers,
    cards,
    activeLayerId = $bindable(),
    onCreateLayer,
    onDeleteLayer,
    readonly = false,
  }: {
    layers: Layer[];
    cards: CardWithGlue[];
    activeLayerId: string | null;
    onCreateLayer: (name: string) => void;
    onDeleteLayer: (layerId: string) => void;
    // Read-only export: keep layer selection, hide create/delete controls.
    readonly?: boolean;
  } = $props();

  let hovering = $state(false);
  let pinned = $state(false);
  let newLayerName = $state("");
  let controlEl: HTMLDivElement = $state()!;

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
  });
  const activeRowClass = css({ backgroundColor: "neutral.bg" });
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
          <div class={css({ position: "relative", "&:hover .layer-delete": { opacity: "1" } })}>
            <button
              class={cx(rowClass, isActive && activeRowClass, css({ paddingRight: "26px" }))}
              role="option"
              aria-selected={isActive}
              onclick={() => (activeLayerId = layer.id)}
            >
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
            </button>
            {#if !layer.isDefault && !readonly}
              <button
                class={cx("layer-delete", css({
                  position: "absolute",
                  right: "5px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: "18px",
                  height: "18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  borderRadius: "2px",
                  fontSize: "13px",
                  color: "neutral.subtle",
                  opacity: "0",
                  transition: "opacity 0.12s, color 0.12s",
                  "&:hover": { color: "state.error" },
                }))}
                title="Delete layer"
                onclick={(e) => { e.stopPropagation(); onDeleteLayer(layer.id); }}
              >×</button>
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
