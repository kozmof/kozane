<script lang="ts">
  import { tick } from "svelte";
  import { css } from "styled-system/css";
  import type { CardWithGlue, Inventory } from "$lib/types";
  import { INVENTORY_CELL, INVENTORY_COLUMNS, INVENTORY_TAB_SIZE, NAME_MAX } from "$lib/constants";
  import { footprintCells, inventoryFootprints, inventoryRows, slotCell } from "$lib/inventory";
  import type { DropTarget } from "../lib/inventory-drop.js";

  let {
    inventory,
    label,
    cards,
    selectedCards,
    draggingCardId,
    dropTarget,
    aimSpan = 1,
    fontFamily,
    readonly = false,
    onClose,
    onRemove,
    onRename,
    onCardMouseDown,
    onCardClick,
    onCardDblClick,
  }: {
    inventory: Inventory;
    /** The inventory's name, or a numbered fallback for an unnamed one. */
    label: string;
    /** The cards stored here. */
    cards: CardWithGlue[];
    selectedCards: ReadonlySet<string>;
    /** The stored card being dragged out right now, drawn faded in its slot. */
    draggingCardId: string | null;
    /** Where a dragged card would land, for highlighting the slot. */
    dropTarget: DropTarget | null;
    /** How many rows the dragged card covers, so the highlight shows all of its cells. */
    aimSpan?: number;
    fontFamily: string;
    readonly?: boolean;
    onClose: () => void;
    onRemove: () => void;
    onRename: (name: string) => void;
    onCardMouseDown: (event: MouseEvent, cardId: string) => void;
    onCardClick: (event: MouseEvent, cardId: string) => void;
    onCardDblClick: (cardId: string) => void;
  } = $props();

  const cell = INVENTORY_CELL;

  /** Each card with the cells it covers, sized by its text so all of it shows. */
  const placed = $derived.by(() => {
    const byId = new Map(cards.map((card) => [card.id, card]));
    return inventoryFootprints(cards, inventory.id).map(({ cardId, slot, span }) => ({
      card: byId.get(cardId)!,
      span,
      ...slotCell(slot),
    }));
  });
  const rows = $derived(
    inventoryRows(placed.map(({ row, column, span }) => ({ slot: row * INVENTORY_COLUMNS + column, span }))),
  );
  const slots = $derived(Array.from({ length: rows * INVENTORY_COLUMNS }, (_, slot) => slot));
  const aimedHere = $derived(
    dropTarget?.kind === "inventory" && dropTarget.inventoryId === inventory.id,
  );
  const aimedSlot = $derived(aimedHere && dropTarget?.kind === "inventory" ? dropTarget.slot : null);
  /** The cells the dragged card would cover if let go now. */
  const aimedCells = $derived(
    new Set(aimedSlot === null ? [] : footprintCells(aimedSlot, aimSpan)),
  );

  let renaming = $state(false);
  let draft = $state("");
  let nameInput = $state<HTMLInputElement>();

  async function startRename() {
    if (readonly) return;
    draft = inventory.name;
    renaming = true;
    await tick();
    nameInput?.select();
  }

  function finishRename(save: boolean) {
    if (!renaming) return;
    renaming = false;
    if (save) onRename(draft.trim());
  }

  const iconButton = css({
    width: "22px",
    height: "22px",
    padding: "0",
    border: "none",
    borderRadius: "2px",
    background: "transparent",
    color: "neutral.secondary",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    _hover: { background: "neutral.border", color: "ink.black" },
  });
</script>

<!-- The whole window takes drops: off a cell, a card goes to the first free slot. -->
<section
  class={css({
    background: "ink.white",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "4px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
    padding: "6px 8px 8px",
    userSelect: "none",
  })}
  style:outline={aimedHere && aimedSlot === null ? "2px solid var(--colors-select-accent)" : "none"}
  aria-label="Inventory {label}"
  data-inventory-window={inventory.id}
  data-inventory-drop={inventory.id}
>
  <header class={css({ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", minHeight: "22px" })}>
    {#if renaming}
      <input
        bind:this={nameInput}
        bind:value={draft}
        maxlength={NAME_MAX}
        aria-label="Inventory name"
        placeholder="Unnamed"
        class={css({ flex: "1", minWidth: "0", padding: "2px 4px", border: "1px solid token(colors.select.accent)", borderRadius: "2px", fontSize: "12px", fontFamily: "inherit", color: "ink.black", background: "ink.white" })}
        onkeydown={(e) => {
          // The board's shortcuts must not see keys typed into the name.
          e.stopPropagation();
          if (e.key === "Enter") finishRename(true);
          else if (e.key === "Escape") finishRename(false);
        }}
        onblur={() => finishRename(true)}
      />
    {:else}
      <button
        class={css({ flex: "1", minWidth: "0", textAlign: "left", padding: "2px 0", border: "none", background: "transparent", fontSize: "12px", fontWeight: "500", color: "ink.black", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: readonly ? "default" : "text" })}
        title={readonly ? label : "Double-click to rename"}
        ondblclick={startRename}
        onkeydown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            void startRename();
          }
        }}
      >{label}</button>
    {/if}
    <span class={css({ fontSize: "10.5px", color: "neutral.secondary", fontVariantNumeric: "tabular-nums" })}>
      {cards.length}
    </span>
    {#if !readonly}
      <button class={iconButton} title="Remove inventory. Its cards go back on the canvas." aria-label="Remove inventory {label}" onclick={onRemove}>
        <svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true">
          <path d="M1 3h9M4 3V1.5h3V3M2.2 3l.6 7.5h5.4L8.8 3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    {/if}
    <button class={iconButton} title="Close" aria-label="Close inventory {label}" onclick={onClose}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
  </header>

  <div
    role="grid"
    aria-label="Slots"
    aria-rowcount={rows}
    aria-colcount={INVENTORY_COLUMNS}
    class={css({ display: "grid" })}
    style:grid-template-columns="repeat({INVENTORY_COLUMNS}, {cell.width}px)"
    style:grid-auto-rows="{cell.height}px"
    style:gap="{cell.gap}px"
  >
    <!-- Every cell is a drop target, drawn underneath. A card covering several cells is laid
         over them, and a drop on it still finds the cell under the pointer. -->
    {#each slots as slot (slot)}
      {@const at = slotCell(slot)}
      {@const aimed = aimedCells.has(slot)}
      <div
        role="gridcell"
        data-inventory-drop={inventory.id}
        data-inventory-slot={slot}
        class={css({ borderRadius: "2px", transition: "background 0.08s, border-color 0.08s" })}
        style:grid-row={at.row + 1}
        style:grid-column={at.column + 1}
        style:background={aimed ? "var(--colors-select-bg)" : "var(--colors-ink-lighter)"}
        style:border="1px dashed {aimed ? 'var(--colors-select-accent)' : 'var(--colors-neutral-border)'}"
      ></div>
    {/each}
    {#each placed as { card, span, row, column } (card.id)}
      {@const selected = selectedCards.has(card.id)}
      <div
        role="button"
        tabindex="0"
        aria-label={card.content ? `Card: ${card.content}` : "Empty card"}
        aria-pressed={selected}
        data-stored-card-id={card.id}
        data-span={span}
        class={css({ position: "relative", zIndex: "1", borderRadius: "2px", overflowY: "auto", overflowX: "hidden", wordBreak: "break-word", whiteSpace: "break-spaces" })}
        style:grid-row="{row + 1} / span {span}"
        style:grid-column={column + 1}
        style:padding="{cell.paddingY}px {cell.paddingX}px"
        style:font-size="{cell.fontSize}px"
        style:line-height={cell.lineHeight}
        style:font-family={fontFamily}
        style:tab-size={INVENTORY_TAB_SIZE}
        style:cursor={readonly ? "default" : "grab"}
        style:background={selected ? "var(--colors-select-surface)" : "var(--colors-ink-white)"}
        style:color={card.content ? "var(--colors-ink-content)" : "var(--colors-neutral-placeholder)"}
        style:border="1px solid {selected ? 'var(--colors-select-accent)' : 'var(--colors-neutral-border)'}"
        style:opacity={draggingCardId === card.id ? 0.35 : 1}
        onmousedown={(e) => onCardMouseDown(e, card.id)}
        onclick={(e) => onCardClick(e, card.id)}
        ondblclick={() => onCardDblClick(card.id)}
        onkeydown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onCardDblClick(card.id);
        }}
      >{card.content || "Empty card…"}</div>
    {/each}
  </div>
</section>
