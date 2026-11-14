<script lang="ts">
  import { css } from "../../styles/css.js";


  interface Props {
    value: string;
    disabled?: boolean;
    onChange: (id: string) => void;
  }

  let { value, disabled = false, onChange }: Props = $props();
  const choices = [{ id: "text", name: "Text" }, { id: "image", name: "Image" }];

  let open = $state(false);
  let dropdownEl: HTMLDivElement = $state()!;

  let active = $derived(choices.find((l) => l.id === value));

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
    {disabled}
    aria-label="Card type"
    aria-expanded={open}
    aria-haspopup="listbox"
    style:border-color={open ? "var(--colors-select-accent)" : "var(--colors-neutral-border)"}
    onclick={() => { open = !open; }}
    onkeydown={(event) => { if (event.key === "Escape") open = false; }}
  >
    <span class={css({ maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
      {active?.name ?? "Text"}
    </span>
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" class={css({ opacity: "0.5", flexShrink: "0" })}>
      <path d="M1.5 3L4 5.5L6.5 3" stroke="var(--colors-ink-black)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <div
      role="listbox"
      aria-label="Card types"
      class={css({ position: "absolute", bottom: "calc(100% + 6px)", left: "0", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "2px", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", padding: "4px", minWidth: "160px", zIndex: "100" })}
    >
      {#each choices as layer (layer.id)}
        {@const isActive = layer.id === value}
        <button
          class={css({ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "6px 10px", border: "none", borderRadius: "2px", cursor: "pointer", fontFamily: "inherit", fontSize: "12px", color: "ink.black", textAlign: "left", background: "transparent", "&:hover": { background: "ink.lighter" } })}
          role="option"
          aria-selected={isActive}
          style:background={isActive ? "var(--colors-neutral-bg)" : "transparent"}
          onclick={() => {
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
