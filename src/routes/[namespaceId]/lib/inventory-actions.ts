import type { CardWithGlue } from "$lib/types";
import { cardSpan, inventoryFootprints, planStow, type InventoryPlacement } from "$lib/inventory";
import type { NamespaceState } from "../namespace-state.svelte.js";
import type { BoardPoint } from "./canvas-viewport.js";
import {
  createInventory,
  deleteInventory,
  failureMessage,
  parseInventory,
  parsePlacements,
  stowCards,
  takeCards,
  updateInventory,
} from "./namespace-api.js";
import { readArray, readFiniteNumber, readString, readStringArray } from "./response.js";

/** The fields a stow or a take changes, held so a failed request can put them back. */
type Whereabouts = Pick<CardWithGlue, "inventory" | "posX" | "posY">;

function whereaboutsOf(cards: CardWithGlue[], cardIds: Iterable<string>): Map<string, Whereabouts> {
  const wanted = new Set(cardIds);
  const held = new Map<string, Whereabouts>();
  for (const { id, inventory, posX, posY } of cards)
    if (wanted.has(id)) held.set(id, { inventory, posX, posY });
  return held;
}

/**
 * Restore only the named cards, against current state, so edits that finished while the
 * request was in flight are kept. See `fieldSnapshot` in `namespace-actions`.
 */
function restored(cards: CardWithGlue[], previous: Map<string, Whereabouts>): CardWithGlue[] {
  return cards.map((card) => {
    const before = previous.get(card.id);
    return before ? { ...card, ...before } : card;
  });
}

function placed(cards: CardWithGlue[], placements: InventoryPlacement[]): CardWithGlue[] {
  const byCard = new Map(placements.map((p) => [p.cardId, p]));
  return cards.map((card) => {
    const p = byCard.get(card.id);
    return p ? { ...card, inventory: { id: p.inventoryId, slot: p.slot } } : card;
  });
}

/**
 * Inventory actions for the board. Stowing and taking update the board first and roll back on
 * failure, the way a card drag does. The slots a stow shows straight away come from the same
 * {@link planStow} the server runs, and the server's answer replaces them.
 */
export function createInventoryActions(state: NamespaceState) {
  /** Drops a new inventory at `position` and opens it. */
  async function add(position: BoardPoint): Promise<void> {
    const res = await createInventory(state.mutationFetcher, state.namespaceId, position);
    const created = res.ok ? parseInventory(await res.json().catch(() => null)) : null;
    if (!created) {
      state.setError(
        res.ok ? "Failed to add inventory" : await failureMessage(res, "Failed to add inventory"),
      );
      return;
    }
    state.inventories = [...state.inventories, created];
    state.openInventoryIds = new Set([...state.openInventoryIds, created.id]);
  }

  function toggle(inventoryId: string): void {
    const next = new Set(state.openInventoryIds);
    if (!next.delete(inventoryId)) next.add(inventoryId);
    state.openInventoryIds = next;
  }

  /**
   * Saves an icon the board has already moved. Returns false so the gesture can put it back.
   * The stored row replaces the dragged one, since the server clamps to the canvas.
   */
  async function persistPosition(inventoryId: string, position: BoardPoint): Promise<boolean> {
    const res = await updateInventory(
      state.mutationFetcher,
      state.namespaceId,
      inventoryId,
      position,
    );
    if (!res.ok) return false;
    const stored = parseInventory(await res.json().catch(() => null));
    if (stored)
      state.inventories = state.inventories.map((i) => (i.id === inventoryId ? stored : i));
    return true;
  }

  async function rename(inventoryId: string, name: string): Promise<void> {
    const before = state.inventories.find(({ id }) => id === inventoryId);
    if (!before || before.name === name) return;
    state.inventories = state.inventories.map((i) => (i.id === inventoryId ? { ...i, name } : i));
    const res = await updateInventory(state.mutationFetcher, state.namespaceId, inventoryId, {
      name,
    });
    if (res.ok) return;
    // Only if nothing renamed it again while this request was out.
    state.inventories = state.inventories.map((i) =>
      i.id === inventoryId && i.name === name ? { ...i, name: before.name } : i,
    );
    state.setError(await failureMessage(res, "Failed to rename inventory"));
  }

  /** Deletes an inventory. Its cards return to the canvas where they were before. */
  async function remove(inventoryId: string): Promise<void> {
    const index = state.inventories.findIndex(({ id }) => id === inventoryId);
    if (index === -1) return;
    const removed = state.inventories[index];
    const wasOpen = state.openInventoryIds.has(inventoryId);
    const held = state.cards.filter((c) => c.inventory?.id === inventoryId).map(({ id }) => id);
    const previous = whereaboutsOf(state.cards, held);

    state.inventories = state.inventories.filter(({ id }) => id !== inventoryId);
    state.openInventoryIds = new Set(
      [...state.openInventoryIds].filter((id) => id !== inventoryId),
    );
    state.cards = state.cards.map((c) =>
      c.inventory?.id === inventoryId ? { ...c, inventory: null } : c,
    );

    const res = await deleteInventory(state.mutationFetcher, state.namespaceId, inventoryId);
    if (res.ok) return;
    if (!state.inventories.some(({ id }) => id === inventoryId))
      state.inventories = [
        ...state.inventories.slice(0, index),
        removed,
        ...state.inventories.slice(index),
      ];
    if (wasOpen) state.openInventoryIds = new Set([...state.openInventoryIds, inventoryId]);
    state.cards = restored(state.cards, previous);
    state.setError(await failureMessage(res, "Failed to remove inventory"));
  }

  /**
   * Puts cards into an inventory, on `slot` or in the first free slots. A stored card leaves
   * its glue group, which the server reports once it has happened.
   */
  async function stow(cardIds: string[], inventoryId: string, slot: number | null): Promise<void> {
    const contentOf = new Map(state.cards.map(({ id, content }) => [id, content]));
    const moving = cardIds.flatMap((cardId) => {
      const content = contentOf.get(cardId);
      return content === undefined ? [] : [{ cardId, span: cardSpan(content) }];
    });
    const plan = planStow(inventoryFootprints(state.cards, inventoryId), moving, slot);
    if (plan.length === 0) return;
    const previous = whereaboutsOf(
      state.cards,
      plan.map(({ cardId }) => cardId),
    );
    state.cards = placed(
      state.cards,
      plan.map((p) => ({ ...p, inventoryId })),
    );

    const res = await stowCards(
      state.mutationFetcher,
      state.namespaceId,
      inventoryId,
      cardIds,
      slot,
    );
    const parsed = res.ok ? await res.json().catch(() => null) : null;
    const placements = parsePlacements(parsed);
    if (!placements) {
      state.cards = restored(state.cards, previous);
      state.setError(
        res.ok ? "Failed to store cards" : await failureMessage(res, "Failed to store cards"),
      );
      return;
    }
    // The server's slots stand even where another writer made them differ from the plan.
    state.cards = placed(state.cards, placements);
    const cleared = new Set(readStringArray(parsed, "clearedCardIds") ?? []);
    if (cleared.size > 0) {
      state.glueRels = state.glueRels.filter((r) => !cleared.has(r.cardId));
      state.cards = state.cards.map((c) => (cleared.has(c.id) ? { ...c, glueId: null } : c));
    }
  }

  /** Puts a stored card on the canvas at `position`. Returns whether the server kept it. */
  async function take(cardId: string, position: BoardPoint): Promise<boolean> {
    const previous = whereaboutsOf(state.cards, [cardId]);
    if (!previous.get(cardId)?.inventory) return false;
    state.cards = state.cards.map((c) =>
      c.id === cardId ? { ...c, inventory: null, ...position } : c,
    );
    const res = await takeCards(state.mutationFetcher, state.namespaceId, [
      { cardId, ...position },
    ]);
    if (res.ok) {
      // The server clamps to the canvas. Draw what it kept, unless the card moved again since.
      const kept = (readArray(await res.json().catch(() => null), "cards") ?? []).find(
        (row) => readString(row, "cardId") === cardId,
      );
      const posX = readFiniteNumber(kept, "posX");
      const posY = readFiniteNumber(kept, "posY");
      if (posX !== undefined && posY !== undefined)
        state.cards = state.cards.map((c) =>
          c.id === cardId && c.posX === position.posX && c.posY === position.posY
            ? { ...c, posX, posY }
            : c,
        );
      return true;
    }
    state.cards = restored(state.cards, previous);
    state.setError(await failureMessage(res, "Failed to take card out"));
    return false;
  }

  return { add, toggle, persistPosition, rename, remove, stow, take };
}

export type InventoryActions = ReturnType<typeof createInventoryActions>;
