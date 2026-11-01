<script lang="ts">
  import { css } from "styled-system/css";
  import type { CardWithGlue } from "$lib/types";
  import type { UiConfig } from "$lib/ui-config";

  /**
   * The action buttons the composer shows in place of its text box while cards are selected.
   * The composer owns the copy status and the namespace picker's open state, because its
   * keyboard shortcuts reach them too.
   */
  type Props = {
    selectedCards: CardWithGlue[];
    /** Whether every selected card shares one glue group. */
    allGlued: boolean;
    primaryCard: CardWithGlue | null;
    /** The selected card when it can be squashed, or null. */
    squashableCard: CardWithGlue | null;
    resizingCardId: string | null;
    otherNamespaces: { id: string; name: string }[];
    shortcuts: UiConfig;
    copyStatus: "idle" | "copied" | "error";
    showNamespacePicker: boolean;
    onCopyId: () => void;
    onStackOrderChange?: (cardIds: string[], direction: "front" | "back") => void;
    onResizeToggle?: (cardId: string) => void;
    onSquashCard?: (cardId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onMoveToNamespace?: (cardIds: string[], targetNamespaceId: string) => void;
    onOpenFilePalette?: () => void;
    onDeleteSelected?: (cardIds: string[]) => void;
  };

  let {
    selectedCards,
    allGlued,
    primaryCard,
    squashableCard,
    resizingCardId,
    otherNamespaces,
    shortcuts,
    copyStatus,
    showNamespacePicker = $bindable(),
    onCopyId,
    onStackOrderChange,
    onResizeToggle,
    onSquashCard,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onMoveToNamespace,
    onOpenFilePalette,
    onDeleteSelected,
  }: Props = $props();
</script>

<!-- Show shortcut hints as visual labels within action buttons. Hide the hints from assistive technology because each button's accessible name already includes its shortcut. -->
{#snippet shortcutHint(key: string)}
  <span
    aria-hidden="true"
    class={css({ position: "absolute", top: "0", right: "0", padding: "4px 6px 0 0", fontSize: "9.5px", lineHeight: "1", color: "currentColor", opacity: "0.55", fontFamily: "mono", pointerEvents: "none" })}
  >{key}</span>
{/snippet}

<div class={css({ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" })}>
{#if selectedCards.length === 1}
  <button
    class={css({ position: "relative", width: "100%", minWidth: "0", padding: "7px 8px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "11.5px", color: copyStatus === "error" ? "state.error" : "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
    aria-label={"Copy card ID " + shortcuts.copyCardIdShortcut}
    title={selectedCards[0].id}
    onclick={onCopyId}
  >
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="4" y="1" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2" />
      <path d="M8 8v2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2" stroke="currentColor" stroke-width="1.2" />
    </svg>
    {copyStatus === "copied" ? "Copied ID" : copyStatus === "error" ? "Copy failed" : "Copy card ID"}
    {@render shortcutHint(shortcuts.copyCardIdShortcut)}
  </button>
{/if}
{#if selectedCards.length === 1 || allGlued}
  <div class={css({ display: "contents" })}>
    <button
      class={css({ position: "relative", minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit" })}
      aria-label={`Bring to front ${shortcuts.bringCardToFrontShortcut}`}
      onclick={() => onStackOrderChange?.(selectedCards.map((c) => c.id), "front")}
    >Bring to front{@render shortcutHint(shortcuts.bringCardToFrontShortcut)}</button>
    <button
      class={css({ position: "relative", flex: "1", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit" })}
      aria-label={`Send to back ${shortcuts.sendCardToBackShortcut}`}
      onclick={() => onStackOrderChange?.(selectedCards.map((c) => c.id), "back")}
    >Send to back{@render shortcutHint(shortcuts.sendCardToBackShortcut)}</button>
  </div>
{/if}
{#if selectedCards.length === 1}
  <div class={css({ display: "contents" })}>
    <button
      class={css({ position: "relative", flex: "1", padding: "8px 12px", background: "ink.white", borderRadius: "4px", cursor: "pointer", fontSize: "12px", fontFamily: "inherit", border: "1px solid" })}
      style:border-color={resizingCardId === selectedCards[0].id ? "var(--colors-select-accent)" : "var(--colors-neutral-border)"}
      style:color={resizingCardId === selectedCards[0].id ? "var(--colors-select-accent)" : "var(--colors-ink-black)"}
      aria-pressed={resizingCardId === selectedCards[0].id}
      aria-label={`${resizingCardId === selectedCards[0].id ? "Done resizing" : "Resize"} ${shortcuts.resizeCardShortcut}`}
      onclick={() => onResizeToggle?.(selectedCards[0].id)}
    >{resizingCardId === selectedCards[0].id ? "Done resizing" : "Resize"}{@render shortcutHint(shortcuts.resizeCardShortcut)}</button>
    <button
      class={css({ position: "relative", minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", fontSize: "12px", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" })}
      style:cursor={squashableCard ? "pointer" : "default"}
      style:color={squashableCard ? "var(--colors-ink-black)" : "var(--colors-neutral-faded)"}
      title={squashableCard
        ? "Replace this card with one card per sentence"
        : "This card has nothing to split on"}
      disabled={!squashableCard}
      aria-label={`Squash ${shortcuts.squashCardShortcut}`}
      onclick={() => squashableCard && onSquashCard?.(squashableCard.id)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <rect x="1.5" y="1" width="9" height="3.5" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
        <rect x="1.5" y="7.5" width="9" height="3.5" rx="0.5" stroke="currentColor" stroke-width="1.2"/>
        <path d="M1 6h10" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5" stroke-linecap="round"/>
      </svg>
      Squash{@render shortcutHint(shortcuts.squashCardShortcut)}
    </button>
  </div>
{/if}
<!-- Glue and unglue actions, shown only when two or more cards are selected -->
{#if selectedCards.length >= 2}
  <div class={css({ display: "contents" })}>
    {#if allGlued}
      <button
        class={css({ position: "relative", flex: "1", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
        aria-label={`Unglue all ${shortcuts.glueCardsShortcut}`}
        onclick={() => onUnglueSelected?.(selectedCards.map((c) => c.id))}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="2" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
          <circle cx="10" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
          <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" />
        </svg>
        Unglue all{@render shortcutHint(shortcuts.glueCardsShortcut)}
      </button>
    {:else}
      <button
        class={css({ position: "relative", flex: "1", padding: "8px 12px", background: "ink.black", border: "1px solid transparent", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.light", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" })}
        aria-label={`Glue ${shortcuts.glueCardsShortcut}`}
        onclick={() => onGlueSelected?.(selectedCards.map((c) => c.id))}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="2" cy="6" r="2" fill="currentColor" />
          <circle cx="10" cy="6" r="2" fill="currentColor" />
          <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" />
        </svg>
        Glue{@render shortcutHint(shortcuts.glueCardsShortcut)}
      </button>
    {/if}
    {#if primaryCard?.glueId}
      <button
        class={css({ position: "relative", padding: "8px 12px", background: "select.bg", border: "1px solid token(colors.select.accent)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "select.text", fontFamily: "inherit", display: "flex", alignItems: "center", gap: "5px", "&:hover": { background: "select.accent", color: "ink.white" } })}
        title="Remove this card from its glue group"
        aria-label={`Unglue this ${shortcuts.unglueCardShortcut}`}
        onclick={() => onUnglueOne?.(primaryCard!.id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="2" cy="6" r="2" stroke="currentColor" stroke-width="1.3" />
          <line x1="4" y1="6" x2="8" y2="6" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.5" />
          <line x1="8" y1="4" x2="11" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          <line x1="11" y1="4" x2="8" y2="8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        Unglue this{@render shortcutHint(shortcuts.unglueCardShortcut)}
      </button>
    {/if}
  </div>
{/if}
<!-- Move to namespace -->
{#if otherNamespaces.length > 0}
  <div class={css({ position: "relative" })}>
    <button
      class={css({ position: "relative", width: "100%", minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
      title="Move to namespace"
      aria-label={`Move to namespace ${shortcuts.moveCardsShortcut}`}
      onclick={() => (showNamespacePicker = !showNamespacePicker)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0">
        <path d="M1 9V4l4-3 4 3v5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        <rect x="4" y="6" width="4" height="3" rx="0.5" stroke="currentColor" stroke-width="1.3"/>
        <path d="M9 6h2M11 6v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
      </svg>
      Move
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style:transform={showNamespacePicker ? "rotate(180deg)" : "none"} style="flex-shrink:0" style:transition="transform 0.15s">
        <path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      {@render shortcutHint(shortcuts.moveCardsShortcut)}
    </button>
    {#if showNamespacePicker}
      <div class={css({ position: "absolute", bottom: "100%", left: "0", minWidth: "100%", width: "max-content", maxWidth: "220px", marginBottom: "4px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", zIndex: "60", overflow: "hidden" })}>
        {#each otherNamespaces as namespace (namespace.id)}
          <button
            class={css({ width: "100%", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", textAlign: "left", display: "block", "&:hover": { background: "ink.lighter" } })}
            onclick={() => {
              onMoveToNamespace?.(selectedCards.map((c) => c.id), namespace.id);
              showNamespacePicker = false;
            }}
          >{namespace.name}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
<!-- Opens the file palette on this selection. -->
{#if onOpenFilePalette}
  <button
    class={css({ position: "relative", width: "100%", minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "ink.black", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "neutral.icon" } })}
    title="Edit a file"
    aria-label={`Edit a file ${shortcuts.openFilePaletteShortcut}`}
    onclick={onOpenFilePalette}
  >
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0">
      <path d="M3 1.5h3.2l2.3 2.3v6.7H3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M6 1.7v2.4h2.4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>
    Edit a file{@render shortcutHint(shortcuts.openFilePaletteShortcut)}
  </button>
{/if}
<!-- Delete action, always shown in selection mode -->
<button
  class={css({ position: "relative", width: "100%", minWidth: "0", padding: "8px 12px", background: "ink.white", border: "1px solid token(colors.neutral.border)", borderRadius: "4px", cursor: "pointer", fontSize: "12px", color: "state.error", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", "&:hover": { borderColor: "state.error" } })}
  title={`Delete ${selectedCards.length === 1 ? "card" : selectedCards.length + " cards"}`}
  aria-label={`Delete ${selectedCards.length === 1 ? "card" : selectedCards.length + " cards"} ${shortcuts.deleteCardsShortcut}`}
  onclick={() => onDeleteSelected?.(selectedCards.map((c) => c.id))}
>
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0">
    <path d="M4.5 2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M1.5 4h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M2.5 4l.7 6h5.6l.7-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <span class={css({ minWidth: "0" })}>Delete {selectedCards.length === 1 ? "card" : selectedCards.length + " cards"}</span>
  {@render shortcutHint(shortcuts.deleteCardsShortcut)}
</button>
</div>
