<script lang="ts">
  import type { KozaneClient } from "../../client/contract.js";
  import { onDestroy, untrack, tick } from "svelte";
  import CardTypeDropdown from "./CardTypeDropdown.svelte";
  import PartitionDropdown from "./PartitionDropdown.svelte";
  import LayerDropdown from "./LayerDropdown.svelte";
  import SelectionActions from "./SelectionActions.svelte";
  import { css } from "../../styles/css.js";
  import type { CardWithGlue, PartitionWithColor, GlueRel, Layer } from "@kozane/core";
  import { DEFAULT_UI_CONFIG, type UiConfig } from "../../ui-config.js";
  import { splitCardContent } from "@kozane/core";
  import { orderLayers } from "../lib/namespace-page.js";

  interface Props {
    editingCard: CardWithGlue | null;
    selectedCards: CardWithGlue[];
    selectionGlueRels: GlueRel[];
    primaryCard: CardWithGlue | null;
    partitions: PartitionWithColor[];
    defaultPartitionId: string;
    layers: Layer[];
    otherNamespaces: { id: string; name: string }[];
    onUploadImage?: KozaneClient["uploadImage"];
    onSubmit: (id: string | null, content: string, partitionId: string) => void;
    onCancel: () => void;
    onPartitionChange?: (partitionId: string) => void;
    onSelectionPartitionChange?: (cardIds: string[], partitionId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onDeleteSelected?: (cardIds: string[]) => void;
    onMoveToNamespace?: (cardIds: string[], targetNamespaceId: string) => void;
    onSelectionLayerChange?: (cardIds: string[], layerId: string) => void;
    onStackOrderChange?: (cardIds: string[], direction: "front" | "back") => void;
    /** Shows or hides the card's resize handle. The drag itself belongs to the canvas. */
    onResizeToggle?: (cardId: string) => void;
    /** Replaces the card with one card per segment of its text. */
    onSquashCard?: (cardId: string) => void;
    /** Opens the file palette on the selection. Absent where there is nothing to open. */
    onOpenFileBrowser?: () => void;
    /**
     * Suspend composer shortcuts while an overlay owns the keyboard, including when focus is
     * outside the overlay's input.
     */
    suspendShortcuts?: boolean;
    /** Card ID whose resize handle is visible, used to show the button's toggle state. */
    resizingCardId?: string | null;
    /** Where a new card goes when it is not the canvas, shown as the input's placeholder. */
    newCardTarget?: string | null;
    shortcuts?: UiConfig;
  }

  let {
    editingCard,
    selectedCards,
    selectionGlueRels,
    primaryCard,
    partitions,
    defaultPartitionId,
    layers,
    otherNamespaces,
    onUploadImage,
    onSubmit,
    onCancel,
    onPartitionChange,
    onSelectionPartitionChange,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onDeleteSelected,
    onMoveToNamespace,
    onSelectionLayerChange,
    onStackOrderChange,
    onResizeToggle,
    onOpenFileBrowser,
    suspendShortcuts = false,
    onSquashCard,
    resizingCardId = null,
    newCardTarget = null,
    shortcuts = DEFAULT_UI_CONFIG,
  }: Props = $props();

  // Preview the server's split result so the button can explain when a card cannot be split.
  // The server also refuses a stored card.
  const squashableCard = $derived(
    selectedCards.length === 1 &&
      selectedCards[0].inventory === null &&
      splitCardContent(selectedCards[0].content).length > 1
      ? selectedCards[0]
      : null,
  );

  let showNamespacePicker = $state(false);
  // Topmost first, to read the way the layer control and the canvas stack.
  const layerChoices = $derived(orderLayers(layers).reverse());
  // Show a current layer only when every selected card shares it.
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

  const composerPartitionId = () =>
    editingCard?.partitionId ?? primaryCard?.partitionId ?? selectedCards[0]?.partitionId ?? defaultPartitionId;

  let cardType = $state('text');
  let imageError = $state('');
  let uploading = $state(false);
  let imageInput: HTMLInputElement;
  async function uploadImage(file: File | undefined) {
    if (!file || uploading) return;
    const targetId = editingCard?.id ?? null;
    const targetPartition = partitionId;
    uploading = true;
    imageError = '';
    content = '';
    try {
      if (!onUploadImage) throw new Error("Image uploads are unavailable");
      const result = await onUploadImage(file);
      content = 'kozane-image:' + result.url;
      onSubmit(targetId, content, targetPartition);
      content = '';
      if (imageInput) imageInput.value = '';
    } catch (err) { imageError = err instanceof Error ? err.message : 'Image upload failed'; }
    finally { uploading = false; }
  }
  let content = $state(untrack(() => editingCard?.content ?? ""));
  let partitionId = $state(untrack(composerPartitionId));
  let createPartitionId = $state(untrack(() => defaultPartitionId));
  let textareaEl: HTMLTextAreaElement = $state()!;
  let suppressNextAutoFocus = false;
  let loadedComposerContext: string | null = null;

  export function focusInput() {
    textareaEl?.focus();
  }

  // Reconcile the selected partition after namespace navigation or deletion because this
  // component can be reused with a different partition list.
  $effect(() => {
    if (partitions.length === 0 || partitions.some(({ id }) => id === createPartitionId)) return;
    createPartitionId = defaultPartitionId;
    if (!partitions.some(({ id }) => id === partitionId)) partitionId = defaultPartitionId;
  });

  $effect(() => {
    const context = editingCard
      ? `edit:${editingCard.id}`
      : selectedCards.length > 0
        ? `selection:${selectedCards.map(({ id }) => id).join(",")}`
        : "create";
    if (context === loadedComposerContext) return;
    // Do not focus on initial page load, when the board should receive single-key shortcuts.
    const opening = loadedComposerContext === null;
    loadedComposerContext = context;
    content = editingCard?.content ?? "";
    cardType = content.startsWith("kozane-image:") ? "image" : "text";
    partitionId = context === "create" ? createPartitionId : composerPartitionId();
    const shouldFocus = !opening && !suppressNextAutoFocus;
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
    if (suspendShortcuts) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    const ids = selectedCards.map((card) => card.id);
    let handled = true;
    if (e.key === shortcuts.clearSelectionShortcut) onCancel();
    else if (e.key === shortcuts.copyCardIdShortcut && selectedCards.length === 1) copySelectedCardId();
    else if (e.key === shortcuts.bringCardToFrontShortcut && (selectedCards.length === 1 || allGlued)) onStackOrderChange?.(ids, "front");
    else if (e.key === shortcuts.sendCardToBackShortcut && (selectedCards.length === 1 || allGlued)) onStackOrderChange?.(ids, "back");
    else if (e.key === shortcuts.glueCardsShortcut && selectedCards.length >= 2) {
      if (allGlued) onUnglueSelected?.(ids);
      else onGlueSelected?.(ids);
    } else if (e.key === shortcuts.unglueCardShortcut && selectedCards.length >= 2 && primaryCard?.glueId) {
      onUnglueOne?.(primaryCard.id);
    } else if (e.key === shortcuts.moveCardsShortcut && otherNamespaces.length > 0) {
      showNamespacePicker = !showNamespacePicker;
    } else if (e.key === shortcuts.resizeCardShortcut && selectedCards.length === 1) {
      onResizeToggle?.(selectedCards[0].id);
    } else if (e.key === shortcuts.squashCardShortcut && squashableCard) {
      onSquashCard?.(squashableCard.id);
    } else if (e.key === shortcuts.openFileBrowserShortcut && onOpenFileBrowser) {
      onOpenFileBrowser();
    } else if (e.key === shortcuts.deleteCardsShortcut) onDeleteSelected?.(ids);
    else handled = false;

    if (handled) e.preventDefault();
  }

  function handleSubmit() {
    if (!content.trim()) return;
    onSubmit(editingCard?.id ?? null, content.trim(), partitionId);
    content = "";
    if (textareaEl) {
      textareaEl.style.height = "auto";
      textareaEl.focus();
    }
  }

  // Pick the mode. Editing takes priority, then a selection of one or more cards, then create.
  let mode = $derived(
    editingCard ? "edit" : selectedCards.length >= 1 ? "selection" : "create",
  );

  let activePartitionColor = $derived(partitions.find((b) => b.id === partitionId));
  let borderColor = $derived(
    mode === "edit" ? (activePartitionColor?.dot ?? "var(--colors-neutral-border)") : "var(--colors-neutral-border)",
  );

  // In selection mode, check whether all selected cards share one glue group.
  let allGlued = $derived(
    selectedCards.length >= 2 &&
      selectedCards.every((c) => c.glueId !== null && c.glueId === selectedCards[0].glueId),
  );
</script>


<svelte:window onkeydown={handleSelectionShortcut} />

<div class={css({ backgroundColor: "ink.light", borderRadius: "0px", border: "1px solid color-mix(in srgb, token(colors.neutral.border) 97%, black)", padding: "10px 16px 14px", flexShrink: "0" })}>
  <!-- Partition selector and mode hint. -->
  <div class={css({ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" })}>
    <PartitionDropdown
      {partitions}
      {partitionId}
      onChange={(id) => {
        partitionId = id;
        if (mode === "create") createPartitionId = id;
        if (mode === "edit") onPartitionChange?.(id);
        if (mode === "selection") onSelectionPartitionChange?.(selectedCards.map((c) => c.id), id);
      }}
    />
    {#if mode === "create"}
      <CardTypeDropdown value={cardType} disabled={uploading} onChange={(value) => { cardType = value; content = ''; imageError = ''; }} />
    {/if}
    {#if mode === "selection" && layerChoices.length > 1 && onSelectionLayerChange}
      <!-- Place the layer picker beside the partition picker because both move selected cards without changing their text. -->
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
      >Clear selection</button>
    {/if}
  </div>

  {#if mode === "selection"}
    <SelectionActions
      {selectedCards}
      {allGlued}
      {primaryCard}
      {squashableCard}
      {resizingCardId}
      {otherNamespaces}
      {shortcuts}
      {copyStatus}
      bind:showNamespacePicker
      onCopyId={copySelectedCardId}
      {onStackOrderChange}
      {onResizeToggle}
      {onSquashCard}
      {onGlueSelected}
      {onUnglueSelected}
      {onUnglueOne}
      {onMoveToNamespace}
      {onOpenFileBrowser}
      {onDeleteSelected}
    />
  {:else}
    {#if cardType === 'image'}
      <input bind:this={imageInput} type="file" accept=".jpg,.jpeg,.png,.svg" aria-label="Choose image" hidden onchange={(event) => uploadImage(event.currentTarget.files?.[0])} disabled={uploading} />

      <div
        role="region"
        aria-label="Drop image here"
        aria-busy={uploading}
        class={css({ background: "ink.white", border: "1px dashed token(colors.neutral.border)", padding: "20px 10px", textAlign: "center", fontSize: "12px", color: "neutral.muted", marginBottom: "8px" })}
        ondragover={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = uploading ? 'none' : 'copy'; }}
        ondrop={(event) => { event.preventDefault(); uploadImage(event.dataTransfer?.files[0]); }}
      >
        <span role="status">{uploading ? 'Uploading…' : 'Drop a JPEG, PNG, or SVG here'}</span>
        {#if imageError}<p role="alert">{imageError}</p>{/if}
      </div>
      <div class={css({ display: "flex", justifyContent: "flex-end" })}>
      <button class={css({ padding: "3px 8px", border: "1px solid token(colors.neutral.border)", borderRadius: "2px", background: "transparent", fontFamily: "inherit", fontSize: "11px", cursor: "pointer", marginTop: "0" })} disabled={uploading} onclick={() => imageInput.click()}>Choose file</button>
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
        placeholder={mode !== "edit" && newCardTarget ? `Add to ${newCardTarget}` : undefined}
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
  {/if}
</div>
