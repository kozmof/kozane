<script lang="ts">
  import { onDestroy, untrack, tick } from "svelte";
  import BundleDropdown from "./BundleDropdown.svelte";
  import LayerDropdown from "./LayerDropdown.svelte";
  import { css } from "styled-system/css";
  import type { CardWithGlue, BundleWithColor, GlueRel, Layer } from "$lib/types";
  import { DEFAULT_UI_CONFIG, type UiConfig } from "$lib/ui-config";
  import { splitCardContent } from "$lib/squash";
  import { orderLayers } from "../lib/project-page.js";

  interface Props {
    editingCard: CardWithGlue | null;
    selectedCards: CardWithGlue[];
    selectionGlueRels: GlueRel[];
    primaryCard: CardWithGlue | null;
    bundles: BundleWithColor[];
    defaultBundleId: string;
    layers: Layer[];
    otherProjects: { id: string; name: string }[];
    onSubmit: (id: string | null, content: string, bundleId: string) => void;
    onCancel: () => void;
    onBundleChange?: (bundleId: string) => void;
    onSelectionBundleChange?: (cardIds: string[], bundleId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onDeleteSelected?: (cardIds: string[]) => void;
    onMoveToProject?: (cardIds: string[], targetProjectId: string) => void;
    onSelectionLayerChange?: (cardIds: string[], layerId: string) => void;
    onStackOrderChange?: (cardId: string, direction: "front" | "back") => void;
    /** Shows or hides the card's resize handle. The drag itself belongs to the canvas. */
    onResizeToggle?: (cardId: string) => void;
    /** Replaces the card with one card per segment of its text. */
    onSquashCard?: (cardId: string) => void;
    /** The card currently showing one, so the button can read as the toggle it is. */
    resizingCardId?: string | null;
    shortcuts?: UiConfig;
  }

  let {
    editingCard,
    selectedCards,
    selectionGlueRels,
    primaryCard,
    bundles,
    defaultBundleId,
    layers,
    otherProjects,
    onSubmit,
    onCancel,
    onBundleChange,
    onSelectionBundleChange,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onDeleteSelected,
    onMoveToProject,
    onSelectionLayerChange,
    onStackOrderChange,
    onResizeToggle,
    onSquashCard,
    resizingCardId = null,
    shortcuts = DEFAULT_UI_CONFIG,
  }: Props = $props();

  // The same split the server would make, asked here so the button can say up front that a
  // card has nothing to split on, rather than by way of an error banner after the request.
  const squashableCard = $derived(
    selectedCards.length === 1 && splitCardContent(selectedCards[0].content).length > 1
      ? selectedCards[0]
      : null,
  );

  let showProjectPicker = $state(false);
  // Topmost first, to read the way the layer control and the canvas stack.
  const layerChoices = $derived(orderLayers(layers).reverse());
  // The layer the picker shows as current: only when the whole selection shares one, so a
  // mixed selection cannot look like it all sits somewhere it does not.
  const selectionLayerId = $derived(
    selectedCards.length > 0 && selectedCards.every((c) => c.layerId === selectedCards[0].layerId)
      ? selectedCards[0].layerId
      : null,
  );
  let copyStatus: "idle" | "copied" | "error" = $state("idle");
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copySelectedCardId() {
    const card = selectedCards.length === 1 ? selectedCards[0] : null;
    if (!card) return;
    try {
      await navigator.clipboard.writeText(card.id);
      copyStatus = "copied";
    } catch {
      copyStatus = "error";
    }
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => (copyStatus = "idle"), 1500);
  }

  onDestroy(() => clearTimeout(copyResetTimer));

  const MAX_TEXTAREA_LINES = 12;

  const composerBundleId = () =>
    editingCard?.bundleId ?? primaryCard?.bundleId ?? selectedCards[0]?.bundleId ?? defaultBundleId;

  let content = $state(untrack(() => editingCard?.content ?? ""));
  let bundleId = $state(untrack(composerBundleId));
  let createBundleId = $state(untrack(() => defaultBundleId));
  let textareaEl: HTMLTextAreaElement = $state()!;
  let suppressNextAutoFocus = false;
  let loadedComposerContext: string | null = null;

  export function focusInput() {
    textareaEl?.focus();
  }

  // The bundles change under the composer when the page moves to another project — warping
  // there does not remount this component — and when a bundle is deleted. Posting a bundle
  // the board no longer has is refused by the server, so fall back to what it does have.
  $effect(() => {
    if (bundles.length === 0 || bundles.some(({ id }) => id === createBundleId)) return;
    createBundleId = defaultBundleId;
    if (!bundles.some(({ id }) => id === bundleId)) bundleId = defaultBundleId;
  });

  $effect(() => {
    const context = editingCard
      ? `edit:${editingCard.id}`
      : selectedCards.length > 0
        ? `selection:${selectedCards.map(({ id }) => id).join(",")}`
        : "create";
    if (context === loadedComposerContext) return;
    loadedComposerContext = context;
    content = editingCard?.content ?? "";
    bundleId = context === "create" ? createBundleId : composerBundleId();
    const shouldFocus = !suppressNextAutoFocus;
    suppressNextAutoFocus = false;
    tick().then(() => {
      if (shouldFocus) textareaEl?.focus();
      if (textareaEl) autoResize(textareaEl);
    });
  });

  function autoResize(el: HTMLTextAreaElement) {
    // Set height to 0 first so scrollHeight always reports full content height.
    // Reading scrollHeight after overflow:hidden or height:auto gives only 1 row.
    el.style.overflowY = "hidden";
    el.style.height = "0";
    const style = getComputedStyle(el);
    const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.65;
    const padV = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const maxH = MAX_TEXTAREA_LINES * lineH + padV;
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
      e.preventDefault();
      suppressNextAutoFocus = true;
      onCancel();
      textareaEl?.blur();
      tick().then(() => {
        suppressNextAutoFocus = false;
        textareaEl?.blur();
      });
    }
  }

  function handleSelectionShortcut(e: KeyboardEvent) {
    if (mode !== "selection") return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    const ids = selectedCards.map((card) => card.id);
    let handled = true;
    if (e.key === shortcuts.clearSelectionShortcut) onCancel();
    else if (e.key === shortcuts.copyCardIdShortcut && selectedCards.length === 1) copySelectedCardId();
    else if (e.key === shortcuts.bringCardToFrontShortcut && selectedCards.length === 1) onStackOrderChange?.(selectedCards[0].id, "front");
    else if (e.key === shortcuts.sendCardToBackShortcut && selectedCards.length === 1) onStackOrderChange?.(selectedCards[0].id, "back");
    else if (e.key === shortcuts.glueCardsShortcut && selectedCards.length >= 2) {
      if (allGlued) onUnglueSelected?.(ids);
      else onGlueSelected?.(ids);
    } else if (e.key === shortcuts.unglueCardShortcut && selectedCards.length >= 2 && primaryCard?.glueId) {
      onUnglueOne?.(primaryCard.id);
    } else if (e.key === shortcuts.moveCardsShortcut && otherProjects.length > 0) {
      showProjectPicker = !showProjectPicker;
    } else if (e.key === shortcuts.resizeCardShortcut && selectedCards.length === 1) {
      onResizeToggle?.(selectedCards[0].id);
    } else if (e.key === shortcuts.squashCardShortcut && squashableCard) {
      onSquashCard?.(squashableCard.id);
    } else if (e.key === shortcuts.deleteCardsShortcut) onDeleteSelected?.(ids);
    else handled = false;

    if (handled) e.preventDefault();
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
    mode === "edit" ? (activeBundleColor?.dot ?? "var(--colors-neutral-border)") : "var(--colors-neutral-border)",
  );

  // Selection mode: all selected cards share the same glue group
  let allGlued = $derived(
    selectedCards.length >= 2 &&
      selectedCards.every((c) => c.glueId !== null && c.glueId === selectedCards[0].glueId),
  );
</script>

<svelte:window onkeydown={handleSelectionShortcut} />

<div class={css({ backgroundColor: "ink.light", borderRadius: "0px", border: "1px solid token(colors.neutral.border)", padding: "10px 16px 14px", flexShrink: "0" })}>
  <!-- Top row: bundle selector + mode hint -->
  <div class={css({ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" })}>
    <BundleDropdown
      {bundles}
      {bundleId}
      onChange={(id) => {
        bundleId = id;
        if (mode === "create") createBundleId = id;
        if (mode === "edit") onBundleChange?.(id);
        if (mode === "selection") onSelectionBundleChange?.(selectedCards.map((c) => c.id), id);
      }}
    />
    {#if mode === "selection" && layerChoices.length > 1 && onSelectionLayerChange}
      <!-- Sits beside the bundle picker because it does the same kind of thing: both move
           the selection to another home without touching what the cards say. -->
      <LayerDropdown
        layers={layerChoices}
        layerId={selectionLayerId}
        onChange={(id) => onSelectionLayerChange?.(selectedCards.map((c) => c.id), id)}
      />
    {/if}
    {#if mode === "edit"}
      <button
        class={css({ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "neutral.muted", fontFamily: "inherit", padding: "0" })}
        onclick={onCancel}
      >Esc to cancel</button>
    {:else if mode === "selection"}
      <span class={css({ marginLeft: "auto", fontSize: "11px", color: "neutral.muted" })}>
        {selectedCards.length} cards
      </span>
      <button
        class={css({ background: "none", border: "none", cursor: "pointer", fontSize: "13px", color: "neutral.muted", fontFamily: "inherit", padding: "0", lineHeight: "1", "&:hover": { color: "ink.black" } })}
        title="Clear selection"
        onclick={onCancel}
      >Clear selection ({shortcuts.clearSelectionShortcut})</button>
    {/if}
  </div>

  {#if mode === "selection"}
    <div class={css({ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" })}>
    {#if selectedCards.length === 1}
      <button
        class={css({ width: "100%", minWidth: "0", padding: "7px 8px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "11.5px", color: copyStatus === "error" ? "state.error" : "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
        aria-label={"Copy card ID (" + shortcuts.copyCardIdShortcut + ")"}
        title={selectedCards[0].id}
        onclick={copySelectedCardId}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="4" y="1" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2" />
          <path d="M8 8v2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2" stroke="currentColor" stroke-width="1.2" />
        </svg>
        {copyStatus === "copied" ? "Copied ID" : copyStatus === "error" ? "Copy failed" : "Copy card ID (" + shortcuts.copyCardIdShortcut + ")"}
      </button>
    {/if}
    {#if selectedCards.length === 1}
      <div class={css({ display: "contents" })}>
        <button class={css({ minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit" })} onclick={() => onStackOrderChange?.(selectedCards[0].id, "front")}>Bring to front ({shortcuts.bringCardToFrontShortcut})</button>
        <button class={css({ flex: "1", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit" })} onclick={() => onStackOrderChange?.(selectedCards[0].id, "back")}>Send to back ({shortcuts.sendCardToBackShortcut})</button>
        <button
          class={css({ flex: "1", padding: "8px 12px", background: "ink.white", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontFamily: "inherit", border: "1px solid" })}
          style:border-color={resizingCardId === selectedCards[0].id ? "var(--colors-select-accent)" : "var(--colors-neutral-border)"}
          style:color={resizingCardId === selectedCards[0].id ? "var(--colors-select-accent)" : "var(--colors-ink-black)"}
          aria-pressed={resizingCardId === selectedCards[0].id}
          onclick={() => onResizeToggle?.(selectedCards[0].id)}
        >{resizingCardId === selectedCards[0].id ? "Done resizing" : "Resize"} ({shortcuts.resizeCardShortcut})</button>
        <button
          class={css({ minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", fontSize: "12px", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" })}
          style:cursor={squashableCard ? "pointer" : "default"}
          style:color={squashableCard ? "var(--colors-ink-black)" : "var(--colors-neutral-faded)"}
          title={squashableCard
            ? "Replace this card with one card per sentence"
            : "This card has nothing to split on"}
          disabled={!squashableCard}
          onclick={() => squashableCard && onSquashCard?.(squashableCard.id)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="1.5" y="1" width="9" height="3.5" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
            <rect x="1.5" y="7.5" width="9" height="3.5" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M1 6h10" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5" stroke-linecap="round"/>
          </svg>
          Squash ({shortcuts.squashCardShortcut})
        </button>
      </div>
    {/if}
    <!-- Glue/Unglue actions: only available when 2+ cards are selected -->
    {#if selectedCards.length >= 2}
      <div class={css({ display: "contents" })}>
        {#if allGlued}
          <button
            class={css({ flex: "1", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
            onclick={() => onUnglueSelected?.(selectedCards.map((c) => c.id))}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
              <circle cx="10" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
              <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" />
            </svg>
            Unglue all ({shortcuts.glueCardsShortcut})
          </button>
        {:else}
          <button
            class={css({ flex: "1", padding: "8px 12px", background: "ink.black", border: "1px solid transparent", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.light", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" })}
            onclick={() => onGlueSelected?.(selectedCards.map((c) => c.id))}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="2" fill="currentColor" />
              <circle cx="10" cy="6" r="2" fill="currentColor" />
              <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" />
            </svg>
            Glue ({shortcuts.glueCardsShortcut})
          </button>
        {/if}
        {#if primaryCard?.glueId}
          <button
            class={css({ padding: "8px 12px", background: "select.bg", border: "1px solid token(colors.select.accent)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "select.text", fontFamily: "inherit", display: "flex", alignItems: "center", gap: "5px", "&:hover": { background: "select.accent", color: "ink.white" } })}
            title="Remove this card from its glue group"
            onclick={() => onUnglueOne?.(primaryCard!.id)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
              <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" />
              <line x1="8" y1="4" x2="11" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              <line x1="11" y1="4" x2="8" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            Unglue this ({shortcuts.unglueCardShortcut})
          </button>
        {/if}
      </div>
    {/if}
    <!-- Move to project -->
    {#if otherProjects.length > 0}
      <div class={css({ position: "relative" })} style:grid-column={selectedCards.length === 1 ? "span 2" : "auto"}>
        <button
          class={css({ width: "100%", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
          onclick={() => (showProjectPicker = !showProjectPicker)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 9V4l4-3 4 3v5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
            <rect x="4" y="6" width="4" height="3" rx="0.5" stroke="currentColor" stroke-width="1.3"/>
            <path d="M9 6h2M11 6v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          Move to project ({shortcuts.moveCardsShortcut})
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style:transform={showProjectPicker ? "rotate(180deg)" : "none"} style:transition="transform 0.15s">
            <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if showProjectPicker}
          <div class={css({ position: "absolute", bottom: "100%", left: "0", right: "0", marginBottom: "4px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", boxShadow: "0 4px 16px rgba(0,0,0,0.03)", zIndex: "60", overflow: "hidden" })}>
            {#each otherProjects as project (project.id)}
              <button
                class={css({ width: "100%", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", textAlign: "left", display: "block", "&:hover": { background: "ink.lighter" } })}
                onclick={() => {
                  onMoveToProject?.(selectedCards.map((c) => c.id), project.id);
                  showProjectPicker = false;
                }}
              >{project.name}</button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <!-- Delete: always visible in selection mode -->
    <button
      style:grid-column={otherProjects.length === 0 ? "1 / -1" : "auto"}
      class={css({ width: "100%", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "state.error", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "state.error" } })}
      onclick={() => onDeleteSelected?.(selectedCards.map((c) => c.id))}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M1.5 4h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M2.5 4l.7 6h5.6l.7-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Delete {selectedCards.length === 1 ? "card" : selectedCards.length + " cards"} ({shortcuts.deleteCardsShortcut})
    </button>
    </div>
  {:else}
    <!-- Input row (create / edit) -->
    <div
      class={css({ display: "flex", alignItems: "center", gap: "8px", background: "ink.white", border: "1px solid", borderRadius: "0px", padding: "8px 10px", transition: "border-color 0.15s", marginBottom: "8px" })}
      style:border-color={borderColor}
    >
      <textarea
        class={css({ flex: "1", resize: "none", border: "none", background: "transparent", padding: "2px 0", fontSize: "12.5px", lineHeight: "1.65", fontFamily: "mono", color: "ink.black", minHeight: "24px" })}
        bind:this={textareaEl}
        bind:value={content}
        oninput={(e) => autoResize(e.currentTarget)}
        onkeydown={handleKeyDown}
        aria-label={mode === "edit" ? "Edit card" : "Write a card"}
        rows={1}
      ></textarea>

      <button
        class={css({ flexShrink: "0", width: "32px", height: "32px", borderRadius: "2px", border: "none", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" })}
        aria-label={mode === "edit" ? "Save" : "Create card"}
        style:background={content.trim() ? "var(--colors-ink-black)" : "var(--colors-neutral-disabled)"}
        style:cursor={content.trim() ? "pointer" : "default"}
        onclick={handleSubmit}
        disabled={!content.trim()}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M7 12V2M3 6l4-4 4 4"
            stroke={content.trim() ? "var(--colors-ink-white)" : "var(--colors-neutral-faded)"}
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
  {/if}
</div>
