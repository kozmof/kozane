<script lang="ts">
  import { css } from "styled-system/css";
  import type { Layer } from "$lib/types";

  interface Props {
    /** Topmost first, the way the canvas stacks them. */
    layers: Layer[];
    layerId: string | null;
    onChange: (id: string) => void;
  }

  let { layers, layerId, onChange }: Props = $props();

  let open = $state(false);
  let dropdownEl: HTMLDivElement = $state()!;

  let active = $derived(layers.find((l) => l.id === layerId));

  $effect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent) {
      if (!dropdownEl?.contains(e.target as Node)) open = false;
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  });
</script>

<div bind:this={dropdownEl} class={css({ position: "relative", flexShrink: "0" })}>
  <button
    class={css({ display: "flex", alignItems: "center", gap: "5px", padding: "3px 8px", border: "1px solid", borderRadius: "2px", cursor: "pointer", fontFamily: "inherit", fontSize: "11px", color: "ink.black", background: "transparent", transition: "all 0.1s" })}
    aria-label="Move selection to layer"
    aria-expanded={open}
    aria-haspopup="listbox"
    style:border-color={open ? "var(--colors-select-accent)" : "var(--colors-neutral-border)"}
    onmousedown={(e) => {
      e.preventDefault();
      open = !open;
    }}
  >
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 1.5L12.5 4.5L7 7.5L1.5 4.5L7 1.5Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
      <path d="M2 8.5L7 11.25L12 8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class={css({ maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
      {active?.name ?? "Layer"}
    </span>
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" class={css({ opacity: "0.5", flexShrink: "0" })}>
      <path d="M1.5 3L4 5.5L6.5 3" stroke="var(--colors-ink-black)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <div
      role="listbox"
      aria-label="Layers"
      class={css({ position: "absolute", bottom: "calc(100% + 6px)", left: "0", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "2px", boxShadow: "0 4px 16px rgba(0,0,0,0.03)", padding: "4px", minWidth: "160px", zIndex: "100" })}
    >
      {#each layers as layer (layer.id)}
        {@const isActive = layer.id === layerId}
        <button
          class={css({ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "6px 10px", border: "none", borderRadius: "2px", cursor: "pointer", fontFamily: "inherit", fontSize: "12px", color: "ink.black", textAlign: "left", background: "transparent", "&:hover": { background: "ink.lighter" } })}
          role="option"
          aria-selected={isActive}
          style:background={isActive ? "var(--colors-neutral-bg)" : "transparent"}
          onmousedown={(e) => {
            e.preventDefault();
            onChange(layer.id);
            open = false;
          }}
        >
          {layer.name}
          {#if isActive}
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style:margin-left="auto">
              <path d="M1 4l3 3 5-6" stroke="var(--colors-ink-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
