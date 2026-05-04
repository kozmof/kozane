<script lang="ts">
  import { untrack, tick } from "svelte";
  import BundleDropdown from "./BundleDropdown.svelte";
  import { css } from "styled-system/css";

  interface CardData {
    id: string;
    content: string;
    bundleId: string;
    glueId: string | null;
  }

  interface Bundle {
    id: string;
    name: string;
    bg: string;
    dot: string;
  }

  interface GlueRel {
    glueId: string;
    cardId: string;
  }

  interface Props {
    editingCard: CardData | null;
    selectedCards: CardData[];
    selectionGlueRels: GlueRel[];
    primaryCard: CardData | null;
    bundles: Bundle[];
    defaultBundleId: string;
    onSubmit: (id: string | null, content: string, bundleId: string) => void;
    onCancel: () => void;
    onBundleChange?: (bundleId: string) => void;
    onSelectionBundleChange?: (cardIds: string[], bundleId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onDeleteSelected?: (cardIds: string[]) => void;
  }

  let {
    editingCard,
    selectedCards,
    selectionGlueRels,
    primaryCard,
    bundles,
    defaultBundleId,
    onSubmit,
    onCancel,
    onBundleChange,
    onSelectionBundleChange,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onDeleteSelected,
  }: Props = $props();

  const MAX_TEXTAREA_LINES = 12;

  let content = $state(untrack(() => editingCard?.content ?? ""));
  let bundleId = $state(untrack(() => editingCard?.bundleId ?? defaultBundleId));
  let textareaEl: HTMLTextAreaElement = $state()!;

  $effect(() => {
    content = editingCard?.content ?? "";
    bundleId = editingCard?.bundleId ?? defaultBundleId;
    tick().then(() => {
      textareaEl?.focus();
      if (textareaEl) autoResize(textareaEl);
    });
  });

  function autoResize(el: HTMLTextAreaElement) {
    // Set height to 0 first so scrollHeight always reports full content height.
    // Reading scrollHeight after overflow:hidden or height:auto gives only 1 row.
    el.style.overflowY = "hidden";
    el.style.height = "0";
    // 12.5px font-size × 1.65 line-height + 4px vertical padding
    const maxH = MAX_TEXTAREA_LINES * (12.5 * 1.65) + 4;
    if (el.scrollHeight > maxH) {
      el.style.height = maxH + "px";
      el.style.overflowY = "auto";
    } else {
      el.style.height = el.scrollHeight + "px";
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (content.trim()) handleSubmit();
    }
    if (e.key === "Escape") {
      onCancel();
      textareaEl?.blur();
    }
  }

  function handleSubmit() {
    if (!content.trim()) return;
    onSubmit(editingCard?.id ?? null, content.trim(), bundleId);
    content = "";
    if (textareaEl) {
      textareaEl.style.height = "auto";
      textareaEl.focus();
    }
  }

  // Mode: edit takes priority, then selection (≥1 card), then create
  let mode = $derived(
    editingCard ? "edit" : selectedCards.length >= 1 ? "selection" : "create",
  );

  let activeBundleColor = $derived(bundles.find((b) => b.id === bundleId));
  let borderColor = $derived(
    mode === "edit" ? (activeBundleColor?.dot ?? "var(--colors-warm-border)") : "var(--colors-warm-border)",
  );

  // Selection mode: all selected cards share the same glue group
  let allGlued = $derived(
    selectedCards.length >= 2 &&
      selectedCards.every((c) => c.glueId !== null && c.glueId === selectedCards[0].glueId),
  );
</script>

<div class={css({ backgroundColor: "ink.light", borderRadius: "10px", padding: "10px 16px 14px", flexShrink: "0" })}>
  <!-- Top row: bundle selector + mode hint -->
  <div class={css({ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" })}>
    <BundleDropdown
      {bundles}
      {bundleId}
      onChange={(id) => {
        bundleId = id;
        if (mode === "edit") onBundleChange?.(id);
        if (mode === "selection") onSelectionBundleChange?.(selectedCards.map((c) => c.id), id);
      }}
    />
    {#if mode === "edit"}
      <button
        class={css({ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "warm.muted", fontFamily: "inherit", padding: "0" })}
        onclick={onCancel}
      >Esc to cancel</button>
    {:else if mode === "selection"}
      <span class={css({ marginLeft: "auto", fontSize: "11px", color: "warm.muted" })}>
        {selectedCards.length} cards
      </span>
      <button
        class={css({ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "warm.muted", fontFamily: "inherit", padding: "0", lineHeight: "1", "&:hover": { color: "ink.black" } })}
        title="Clear selection"
        onclick={onCancel}
      >×</button>
    {/if}
  </div>

  {#if mode === "selection"}
    <!-- Glue/Unglue actions: only available when 2+ cards are selected -->
    {#if selectedCards.length >= 2}
      <div class={css({ display: "flex", gap: "6px", marginBottom: "6px" })}>
        {#if allGlued}
          <button
            class={css({ flex: "1", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.warm.border)", borderRadius: "8px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "warm.icon" } })}
            onclick={() => onUnglueSelected?.(selectedCards.map((c) => c.id))}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
              <circle cx="10" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
              <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" />
            </svg>
            Unglue all
          </button>
        {:else}
          <button
            class={css({ flex: "1", padding: "8px 12px", background: "ink.black", border: "1px solid transparent", borderRadius: "8px", cursor: "pointer", fontSize: "12px", color: "ink.light", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" })}
            onclick={() => onGlueSelected?.(selectedCards.map((c) => c.id))}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="2" fill="currentColor" />
              <circle cx="10" cy="6" r="2" fill="currentColor" />
              <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" />
            </svg>
            Glue
          </button>
        {/if}
        {#if primaryCard?.glueId}
          <button
            class={css({ padding: "8px 12px", background: "select.bg", border: "1px solid token(colors.select.accent)", borderRadius: "8px", cursor: "pointer", fontSize: "12px", color: "select.text", fontFamily: "inherit", display: "flex", alignItems: "center", gap: "5px", "&:hover": { background: "select.accent", color: "ink.white" } })}
            title="Remove this card from its glue group"
            onclick={() => onUnglueOne?.(primaryCard!.id)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
              <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" />
              <line x1="8" y1="4" x2="11" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              <line x1="11" y1="4" x2="8" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            Unglue this
          </button>
        {/if}
      </div>
    {/if}
    <!-- Delete: always visible in selection mode -->
    <button
      class={css({ width: "100%", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.warm.border)", borderRadius: "8px", cursor: "pointer", fontSize: "12px", color: "state.error", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "state.error" } })}
      onclick={() => onDeleteSelected?.(selectedCards.map((c) => c.id))}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M1.5 4h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M2.5 4l.7 6h5.6l.7-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Delete {selectedCards.length === 1 ? "card" : `${selectedCards.length} cards`}
    </button>
  {:else}
    <!-- Input row (create / edit) -->
    <div
      class={css({ display: "flex", alignItems: "flex-end", gap: "8px", background: "ink.white", border: "1px solid", borderRadius: "8px", padding: "8px 10px", transition: "border-color 0.15s" })}
      style:border-color={borderColor}
    >
      <textarea
        class={css({ flex: "1", resize: "none", border: "none", background: "transparent", padding: "2px 0", fontSize: "12.5px", lineHeight: "1.65", fontFamily: "mono", color: "ink.black", minHeight: "24px" })}
        bind:this={textareaEl}
        bind:value={content}
        oninput={(e) => autoResize(e.currentTarget)}
        onkeydown={handleKeyDown}
        placeholder={mode === "edit"
          ? "Edit card… (Enter to save, Esc to cancel)"
          : "Write a card… (Enter to create, Shift+Enter for newline)"}
        rows={1}
      ></textarea>

      <button
        class={css({ flexShrink: "0", width: "32px", height: "32px", borderRadius: "6px", border: "none", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" })}
        aria-label={mode === "edit" ? "Save" : "Create card"}
        style:background={content.trim() ? "var(--colors-ink-black)" : "var(--colors-warm-disabled)"}
        style:cursor={content.trim() ? "pointer" : "default"}
        onclick={handleSubmit}
        disabled={!content.trim()}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M7 12V2M3 6l4-4 4 4"
            stroke={content.trim() ? "var(--colors-ink-white)" : "var(--colors-warm-faded)"}
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <div class={css({ marginTop: "5px", fontSize: "10px", color: "warm.muted" })}>
      Enter to {mode === "edit" ? "save" : "create"} · Shift+Enter for newline
    </div>
  {/if}
</div>
