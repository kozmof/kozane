<script lang="ts">
  import { css } from "styled-system/css";
  import type { BundleWithColor } from "$lib/types";

  interface Props {
    bundles: BundleWithColor[];
    bundleId: string;
    onChange: (id: string) => void;
  }

  let { bundles, bundleId, onChange }: Props = $props();

  let open = $state(false);
  let dropdownEl: HTMLDivElement = $state()!;

  let active = $derived(bundles.find((b) => b.id === bundleId) ?? bundles[0]);

  $effect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent) {
      if (!dropdownEl?.contains(e.target as Node)) open = false;
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  });

  const dotClass = css({ width: "7px", height: "7px", borderRadius: "50%", flexShrink: "0" });
</script>

<div bind:this={dropdownEl} class={css({ position: "relative", flexShrink: "0" })}>
  <button
    class={css({ display: "flex", alignItems: "center", gap: "5px", padding: "3px 8px 3px 6px", border: "1px solid", borderRadius: "5px", cursor: "pointer", fontFamily: "inherit", fontSize: "11px", color: "ink.black", transition: "all 0.1s" })}
    aria-label="Select bundle"
    aria-expanded={open}
    aria-haspopup="listbox"
    style:border-color={open ? active?.dot : "var(--colors-warm-border)"}
    style:background={open ? active?.bg : "transparent"}
    onmousedown={(e) => {
      e.preventDefault();
      open = !open;
    }}
  >
    <span class={dotClass} style:background={active?.dot}></span>
    <span class={css({ maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
      {active?.name ?? "Bundle"}
    </span>
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" class={css({ opacity: "0.5", marginLeft: "1px", flexShrink: "0" })}>
      <path d="M1.5 3L4 5.5L6.5 3" stroke="var(--colors-ink-black)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <div
      role="listbox"
      aria-label="Bundles"
      class={css({
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: "0",
        background: "ink.white",
        border: "1px solid token(colors.warm.border)",
        borderRadius: "7px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
        padding: "4px",
        minWidth: "160px",
        zIndex: "100",
      })}
    >
      {#each bundles as b (b.id)}
        {@const isActive = b.id === bundleId}
        <button
          class={css({ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "6px 10px", border: "none", borderRadius: "5px", cursor: "pointer", fontFamily: "inherit", fontSize: "12px", color: "ink.black", textAlign: "left" })}
          role="option"
          aria-selected={isActive}
          style:background={isActive ? b.bg : "transparent"}
          onmousedown={(e) => {
            e.preventDefault();
            onChange(b.id);
            open = false;
          }}
        >
          <span class={dotClass} style:background={b.dot}></span>
          {b.name}
          {#if isActive}
            <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style:margin-left="auto">
              <path d="M1 4l3 3 5-6" stroke={b.dot} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
