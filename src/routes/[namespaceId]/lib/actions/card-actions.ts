import * as api from "../namespace-api.js";
import type { NamespaceState } from "../../namespace-state.svelte.js";
import { storedCardIds } from "$lib/inventory";
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
export function createCardActions(state: NamespaceState) {
  async function handleCardPartitionChange(newPartitionId: string) {
    if (!state.selection.composerCard) return;
    const cardId = state.selection.composerCard.id;
    const previous = fieldSnapshot(state.cards, [cardId], "partitionId");
    state.cards = state.cards.map((c) =>
      c.id === cardId ? { ...c, partitionId: newPartitionId } : c,
    );
    const res = await api.updateCard(state.mutationFetcher, state.namespaceId, cardId, {
      partitionId: newPartitionId,
    });
    if (!res.ok) {
      state.cards = restoreField(state.cards, "partitionId", previous);
      state.setError("Failed to change partition");
    }
  }

  async function handleSelectionPartitionChange(cardIds: string[], newPartitionId: string) {
    const previous = fieldSnapshot(state.cards, cardIds, "partitionId");
    const moving = new Set(cardIds);
    state.cards = state.cards.map((c) =>
      moving.has(c.id) ? { ...c, partitionId: newPartitionId } : c,
    );
    const res = await api.batchReassignPartition(
      state.mutationFetcher,
      state.namespaceId,
      cardIds,
      newPartitionId,
    );
    if (!res.ok) {
      state.cards = restoreField(state.cards, "partitionId", previous);
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
    const res = await api.glueCards(state.mutationFetcher, state.namespaceId, cardIds);
    if (!res.ok) {
      state.setError("Failed to glue cards");
      return;
    }
    const parsed = await res.json().catch(() => null);
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
    const res = await api.unglueCards(state.mutationFetcher, state.namespaceId, cardIds);
    if (!res.ok) {
      state.setError(errorMsg);
      return;
    }
    const cleared = readStringArray(await res.json().catch(() => null), "clearedCardIds");
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
    const res = await api.deleteCards(state.mutationFetcher, state.namespaceId, cardIds);
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
    const res = await api.squashCard(state.mutationFetcher, state.namespaceId, cardId);
    if (!res.ok) {
      // Preserve the server's squash error so the user can identify why the selected card
      // cannot be split.
      state.setError(await api.failureMessage(res, "Failed to squash card"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    const cards = api.parseCards(parsed);
    const inventory = api.parseInventory(readObject(parsed, "inventory"));
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
    const res = await api.moveCardsToNamespace(
      state.mutationFetcher,
      state.namespaceId,
      cardIds,
      targetNamespaceId,
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
    const res = await api.batchReassignLayer(
      state.mutationFetcher,
      state.namespaceId,
      cardIds,
      layerId,
    );
    if (!res.ok) {
      state.cards = restoreField(state.cards, "layerId", previous);
      state.setError("Failed to move cards to another layer");
      return;
    }
    // The server restacks arriving cards above the target layer's own, and says where they
    // landed. Applying that keeps the canvas from drawing them in the order they had on the
    // layer they came from until the next snapshot poll corrects it.
    const parsed = await res.json().catch(() => null);
    state.cards = withStacking(state.cards, readStacking(parsed));
    // Select the destination layer so the moved cards remain in front.
    state.activeLayerId = layerId;
  }

  /**
   * Restack the selected card or glue group within each card's current layer. Apply the
   * server's returned stacking values because groups can span layers.
   */
  async function handleStackOrderChange(cardIds: string[], direction: "front" | "back") {
    const res = await api.batchChangeStackOrder(
      state.mutationFetcher,
      state.namespaceId,
      cardIds,
      direction,
    );
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to change card stacking order"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    state.cards = withStacking(state.cards, readStacking(parsed));
  }

  return {
    handleCardPartitionChange,
    handleSelectionPartitionChange,
    handleGlueSelected,
    handleUnglueOne,
    handleUnglueSelected,
    handleDeleteSelected,
    handleSquashCard,
    handleMoveSelectionToNamespace,
    handleSelectionLayerChange,
    handleStackOrderChange,
  };
}
