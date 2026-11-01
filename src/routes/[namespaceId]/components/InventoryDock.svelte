<script lang="ts">
  import { css } from "styled-system/css";
  import { cardSpan } from "$lib/inventory";
  import { INVENTORY_CELL } from "$lib/constants";
  import type { Inventory } from "$lib/types";
  import type { NamespaceState } from "../namespace-state.svelte.js";
  import type { createInventoryActions } from "../lib/inventory-actions.js";
  import type { InventoryDrag } from "../lib/inventory-drop.js";
  import { STOWED_GRAB_INSET } from "../lib/board-gestures.svelte.js";
  import { selectStoredCard } from "../lib/stored-card-selection.js";
  import InventoryWindow from "./InventoryWindow.svelte";

  /**
   * The open inventories, stacked down the left of the canvas, and the preview of a card
   * being carried out of one. Both stay put while the canvas pans, so a card can be carried
   * in from anywhere on the board.
   */
  type Props = {
    s: NamespaceState;
    inventoryActions: ReturnType<typeof createInventoryActions>;
    inventoryLabel: (inventory: Inventory) => string;
    /** The drag the canvas reports, for slot highlighting and the carried card's preview. */
    inventoryDrag: InventoryDrag;
    zoom: number;
    fontFamily: string;
    readonly: boolean;
    onCardMouseDown: (e: MouseEvent, cardId: string) => void;
  };

  let {
    s,
    inventoryActions,
    inventoryLabel,
    inventoryDrag,
    zoom,
    fontFamily,
    readonly,
    onCardMouseDown,
  }: Props = $props();

  let cardById = $derived(new Map(s.cards.map((c) => [c.id, c])));

  /** The open inventories, in creation order, each with the cards it holds. */
  let openInventories = $derived(
    s.inventories
      .filter(({ id }) => s.openInventoryIds.has(id))
      .map((inventory) => ({
        inventory,
        cards: s.cards.filter((c) => c.inventory?.id === inventory.id),
      })),
  );

  /** Rows the carried card covers, for the drop highlight. */
  let carriedSpan = $derived.by(() => {
    const carried = inventoryDrag.carriedCardId ? cardById.get(inventoryDrag.carriedCardId) : null;
    return carried ? cardSpan(carried.content) : 1;
  });

  let draggedStoredCard = $derived(
    inventoryDrag.cardId ? (cardById.get(inventoryDrag.cardId) ?? null) : null,
  );

  function handleStoredCardClick(e: MouseEvent, cardId: string) {
    if (readonly) return;
    selectStoredCard(s.selection, e, cardId);
  }

  function handleStoredCardDblClick(cardId: string) {
    if (readonly) return;
    const card = cardById.get(cardId);
    if (card) s.selection.composerCard = card;
  }
</script>

{#if openInventories.length > 0}
  <div
    class={css({ position: "absolute", top: "12px", left: "12px", zIndex: "52", display: "flex", flexDirection: "column", gap: "8px", maxHeight: "calc(100% - 96px)", overflowY: "auto", overflowX: "hidden" })}
    data-inventory-dock
  >
    {#each openInventories as { inventory, cards } (inventory.id)}
      <InventoryWindow
        {inventory}
        label={inventoryLabel(inventory)}
        {cards}
        selectedCards={s.selection.selectedCards}
        draggingCardId={inventoryDrag.pointer ? inventoryDrag.cardId : null}
        dropTarget={inventoryDrag.target}
        aimSpan={carriedSpan}
        {fontFamily}
        {readonly}
        onClose={() => inventoryActions.toggle(inventory.id)}
        onRemove={() => void inventoryActions.remove(inventory.id)}
        onRename={(name) => void inventoryActions.rename(inventory.id, name)}
        onCardMouseDown={onCardMouseDown}
        onCardClick={handleStoredCardClick}
        onCardDblClick={handleStoredCardDblClick}
      />
    {/each}
  </div>
{/if}

<!-- The card being carried out of a grid, following the pointer. It lets the pointer
     through so whatever is underneath can be found as the drop target. -->
{#if draggedStoredCard && inventoryDrag.pointer}
  {@const draggedStoredSpan = cardSpan(draggedStoredCard.content)}
  <div
    aria-hidden="true"
    data-stored-card-preview
    class={css({ position: "fixed", zIndex: "1000", pointerEvents: "none", overflow: "hidden", background: "ink.white", border: "1px solid token(colors.select.accent)", boxShadow: "0 4px 12px rgba(0,0,0,0.08)", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "ink.content" })}
    style:left="{inventoryDrag.pointer.x - STOWED_GRAB_INSET * zoom}px"
    style:top="{inventoryDrag.pointer.y - STOWED_GRAB_INSET * zoom}px"
    style:width="{INVENTORY_CELL.width}px"
    style:height="{draggedStoredSpan * INVENTORY_CELL.height + (draggedStoredSpan - 1) * INVENTORY_CELL.gap}px"
    style:padding="{INVENTORY_CELL.paddingY}px {INVENTORY_CELL.paddingX}px"
    style:font-size="{INVENTORY_CELL.fontSize}px"
    style:line-height={INVENTORY_CELL.lineHeight}
    style:font-family={fontFamily}
  >{draggedStoredCard.content || "Empty card…"}</div>
{/if}
