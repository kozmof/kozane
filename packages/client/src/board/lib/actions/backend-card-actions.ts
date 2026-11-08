function failureMessage(error: unknown, fallback: string) {
  return error instanceof ClientError ? error.message : fallback;
}
async function attempt<T>(
  work: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}
function readCards(value: unknown) {
  const rows = readArray(value, "cards");
  if (!rows) return undefined;
  const cards = rows.map(readCard);
  return cards.every((card): card is NonNullable<typeof card> => card !== undefined)
    ? cards
    : undefined;
}
import type { KozaneClient } from "../../../backend/contract.js";
import { ClientError } from "../../../backend/contract.js";
import { readCard, readInventory } from "../../../backend/decoders/snapshot-reader.js";
import { readArray } from "../../../backend/decoders/response.js";
import type { NamespaceState } from "../../namespace-state.svelte.js";
import { storedCardIds } from "@kozane/core";
import { readObject, readString, readStringArray } from "../response.js";
import {
  fieldSnapshot,
  readStacking,
  reinsert,
  reinsertGlueRels,
  restoreField,
  withStacking,
} from "./shared.js";
/** Card actions: partition and layer moves, glue, stacking, delete, squash, and namespace moves. */
export function createClientCardActions(
  state: NamespaceState,
  backend: Pick<KozaneClient, "cards" | "glues">,
) {
  function track<Args extends unknown[], R>(work: (...args: Args) => Promise<R>) {
    return (...args: Args) => state.mutations.track(() => work(...args));
  }
  async function handleCardPartitionChange(newPartitionId: string) {
    if (!state.selection.composerCard) return;
    const cardId = state.selection.composerCard.id;
    const previous = fieldSnapshot(state.cards, [cardId], "partitionId");
    state.cards = state.cards.map((c) =>
      c.id === cardId ? { ...c, partitionId: newPartitionId } : c,
    );
    const res = await attempt(() =>
      backend.cards.update(state.namespaceId, cardId, {
        partitionId: newPartitionId,
      }),
    );
    if (!res.ok) {
      state.cards = restoreField(state.cards, "partitionId", previous, newPartitionId);
      state.setError("Failed to change partition");
    }
  }
  async function handleSelectionPartitionChange(cardIds: string[], newPartitionId: string) {
    const previous = fieldSnapshot(state.cards, cardIds, "partitionId");
    const moving = new Set(cardIds);
    state.cards = state.cards.map((c) =>
      moving.has(c.id) ? { ...c, partitionId: newPartitionId } : c,
    );
    const res = await attempt(() =>
      backend.cards.setPartition(state.namespaceId, {
        cardIds: cardIds,
        partitionId: newPartitionId,
      }),
    );
    if (!res.ok) {
      state.cards = restoreField(state.cards, "partitionId", previous, newPartitionId);
      state.setError("Failed to change partition for selected cards");
    }
  }
  // Glue and scope membership actions update local state only after success, so failures need
  // no rollback.
  async function handleGlueSelected(selectedIds: string[]) {
    // A selection can reach into an inventory, and the server refuses to glue a stored card.
    const stored = storedCardIds(state.cards);
    const cardIds = selectedIds.filter((id) => !stored.has(id));
    // The server needs at least two cards. Name stored cards when they are why too few remain.
    if (cardIds.length < 2) {
      state.setError(
        cardIds.length < selectedIds.length
          ? "Stored cards cannot be glued"
          : "Select at least two cards to glue",
      );
      return;
    }
    const res = await attempt(() => backend.glues.create(state.namespaceId, { cardIds: cardIds }));
    if (!res.ok) {
      state.setError("Failed to glue cards");
      return;
    }
    const parsed = res.data;
    const glueId = readString(parsed, "glueId");
    if (glueId === undefined) {
      state.setError("Failed to glue cards");
      return;
    }
    // Leftover members of groups this glue emptied. A missing list leaves them to the next poll.
    const cleared = new Set(readStringArray(parsed, "clearedCardIds") ?? []);
    const glued = new Set(cardIds);
    state.glueRels = [
      ...state.glueRels.filter((r) => !glued.has(r.cardId) && !cleared.has(r.cardId)),
      ...cardIds.map((cardId) => ({ glueId, cardId })),
    ];
    state.cards = state.cards.map((c) =>
      glued.has(c.id) ? { ...c, glueId } : cleared.has(c.id) ? { ...c, glueId: null } : c,
    );
  }
  async function unglue(cardIds: string[], errorMsg: string) {
    const res = await attempt(() => backend.glues.remove(state.namespaceId, { cardIds: cardIds }));
    if (!res.ok) {
      state.setError(errorMsg);
      return;
    }
    const cleared = readStringArray(res.data, "clearedCardIds");
    if (cleared === undefined) {
      state.setError(errorMsg);
      return;
    }
    const clearedSet = new Set(cleared);
    state.glueRels = state.glueRels.filter((r) => !clearedSet.has(r.cardId));
    state.cards = state.cards.map((c) => (clearedSet.has(c.id) ? { ...c, glueId: null } : c));
  }
  async function handleUnglueOne(cardId: string) {
    await unglue([cardId], "Failed to unglue card");
  }
  async function handleUnglueSelected(cardIds: string[]) {
    await unglue(cardIds, "Failed to unglue cards");
  }
  /**
   * Remove cards optimistically and return a rollback function. Deletion and namespace
   * moves share this local update but use different requests and error messages.
   */
  function removeCardsOptimistically(cardIds: string[]): () => void {
    const cardIdSet = new Set(cardIds);
    const removedCards = state.cards.filter((c) => cardIdSet.has(c.id));
    const removedGlueRels = state.glueRels.filter((r) => cardIdSet.has(r.cardId));
    const wasSelected = [...state.selection.selectedCards].filter((id) => cardIdSet.has(id));
    const pid = state.selection.primarySelectedId;
    const wasPrimary = pid !== null && cardIdSet.has(pid) ? pid : null;
    state.cards = state.cards.filter((c) => !cardIdSet.has(c.id));
    state.glueRels = state.glueRels.filter((r) => !cardIdSet.has(r.cardId));
    state.selection.selectedCards = new Set(
      [...state.selection.selectedCards].filter((id) => !cardIdSet.has(id)),
    );
    if (wasPrimary) state.selection.primarySelectedId = null;
    return () => {
      state.cards = reinsert(state.cards, removedCards);
      state.glueRels = reinsertGlueRels(state.glueRels, removedGlueRels);
      state.selection.selectedCards = new Set([...state.selection.selectedCards, ...wasSelected]);
      // Restore selection only if the user has not selected another card during the request.
      if (wasPrimary && state.selection.primarySelectedId === null)
        state.selection.primarySelectedId = wasPrimary;
    };
  }
  async function handleDeleteSelected(cardIds: string[]) {
    const undo = removeCardsOptimistically(cardIds);
    const res = await attempt(() => backend.cards.remove(state.namespaceId, { cardIds: cardIds }));
    if (!res.ok) {
      undo();
      state.setError("Failed to delete cards");
    }
  }
  /**
   * Split a card by text segments. Apply the returned IDs and positions only after server
   * confirmation, so failure requires no local rollback.
   */
  async function handleSquashCard(cardId: string) {
    const res = await attempt(() => backend.cards.squash(state.namespaceId, { cardId: cardId }));
    if (!res.ok) {
      // Preserve the server's squash error so the user can identify why the selected card
      // cannot be split.
      state.setError(failureMessage(res.error, "Failed to squash card"));
      return;
    }
    const parsed = res.data;
    const cards = readCards(parsed);
    const inventory = readInventory(readObject(parsed, "inventory"));
    if (!cards || !inventory) {
      state.setError("Failed to squash card");
      return;
    }
    // Cards above the original were raised to make room for the pieces.
    state.cards = [
      ...withStacking(
        state.cards.filter((c) => c.id !== cardId),
        readStacking(parsed),
      ),
      ...cards,
    ];
    state.glueRels = state.glueRels.filter((r) => r.cardId !== cardId);
    // The pieces inherit the card's scope memberships server-side, so the sidebar's counts
    // follow them here rather than waiting a poll to catch up.
    const scopeIds = state.scopeRels.filter((r) => r.cardId === cardId).map((r) => r.scopeId);
    state.scopeRels = [
      ...state.scopeRels.filter((r) => r.cardId !== cardId),
      ...scopeIds.flatMap((scopeId) => cards.map((c) => ({ scopeId, cardId: c.id }))),
    ];
    // The pieces sit in a new inventory where the card was. Open it so they stay in view.
    state.inventories = [...state.inventories, inventory];
    state.openInventoryIds = new Set([...state.openInventoryIds, inventory.id]);
    state.selection.selectedCards = new Set(
      [...state.selection.selectedCards].filter((id) => id !== cardId),
    );
    if (state.selection.primarySelectedId === cardId) state.selection.primarySelectedId = null;
    state.selection.composerCard = null;
    state.selection.resizingCardId = null;
  }
  async function handleMoveSelectionToNamespace(cardIds: string[], targetNamespaceId: string) {
    const undo = removeCardsOptimistically(cardIds);
    const res = await attempt(() =>
      backend.cards.move(state.namespaceId, {
        cardIds: cardIds,
        targetNamespaceId: targetNamespaceId,
      }),
    );
    if (!res.ok) {
      undo();
      state.setError("Failed to move cards to namespace");
    }
  }
  async function handleSelectionLayerChange(cardIds: string[], layerId: string) {
    const previous = fieldSnapshot(state.cards, cardIds, "layerId");
    const moving = new Set(cardIds);
    state.cards = state.cards.map((c) => (moving.has(c.id) ? { ...c, layerId } : c));
    const res = await attempt(() =>
      backend.cards.setLayer(state.namespaceId, { cardIds: cardIds, layerId: layerId }),
    );
    if (!res.ok) {
      state.cards = restoreField(state.cards, "layerId", previous, layerId);
      state.setError("Failed to move cards to another layer");
      return;
    }
    // Apply server-assigned stacking immediately so arriving cards appear above existing
    // cards on the target layer without waiting for a snapshot poll.
    const parsed = res.data;
    state.cards = withStacking(state.cards, readStacking(parsed));
    // Select the destination layer so the moved cards remain in front.
    state.activeLayerId = layerId;
  }
  /**
   * Restack the selected card or glue group within each card's current layer. Apply the
   * server's returned stacking values because groups can span layers.
   */
  async function handleStackOrderChange(cardIds: string[], direction: "front" | "back") {
    const res = await attempt(() =>
      backend.cards.setStacking(state.namespaceId, { cardIds: cardIds, direction: direction }),
    );
    if (!res.ok) {
      state.setError(failureMessage(res.error, "Failed to change card stacking order"));
      return;
    }
    const parsed = res.data;
    state.cards = withStacking(state.cards, readStacking(parsed));
  }
  return {
    handleCardPartitionChange: track(handleCardPartitionChange),
    handleSelectionPartitionChange: track(handleSelectionPartitionChange),
    handleGlueSelected: track(handleGlueSelected),
    handleUnglueOne: track(handleUnglueOne),
    handleUnglueSelected: track(handleUnglueSelected),
    handleDeleteSelected: track(handleDeleteSelected),
    handleSquashCard: track(handleSquashCard),
    handleMoveSelectionToNamespace: track(handleMoveSelectionToNamespace),
    handleSelectionLayerChange: track(handleSelectionLayerChange),
    handleStackOrderChange: track(handleStackOrderChange),
  };
}
