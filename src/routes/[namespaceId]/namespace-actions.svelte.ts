import * as api from "./lib/namespace-api.js";
import type { CardWithGlue, GlueRel } from "$lib/types";
import type { NamespaceState } from "./namespace-state.svelte.js";
import type { BoardRect } from "$lib/constants";
import { storedCardIds } from "$lib/inventory";
import {
  readArray,
  readFiniteNumber,
  readObject,
  readString,
  readStringArray,
} from "./lib/response.js";

/**
 * Roll back only the affected cards and fields against current state. Restoring a captured
 * array would also undo unrelated edits completed while the failed request was in flight.
 */
function fieldSnapshot<K extends keyof CardWithGlue>(
  cards: CardWithGlue[],
  cardIds: Iterable<string>,
  field: K,
): Map<string, CardWithGlue[K]> {
  const wanted = new Set(cardIds);
  const previous = new Map<string, CardWithGlue[K]>();
  for (const card of cards) if (wanted.has(card.id)) previous.set(card.id, card[field]);
  return previous;
}

function restoreField<K extends keyof CardWithGlue>(
  cards: CardWithGlue[],
  field: K,
  previous: Map<string, CardWithGlue[K]>,
): CardWithGlue[] {
  return cards.map((card) =>
    previous.has(card.id) ? { ...card, [field]: previous.get(card.id)! } : card,
  );
}

/**
 * Restore removed rows unless they already reappeared. Append them because canvas stacking
 * follows layer and zIndex rather than array position.
 */
function reinsert<T extends { id: string }>(current: T[], removed: T[]): T[] {
  const present = new Set(current.map(({ id }) => id));
  return [...current, ...removed.filter(({ id }) => !present.has(id))];
}

function reinsertGlueRels(current: GlueRel[], removed: GlueRel[]): GlueRel[] {
  const present = new Set(current.map(({ cardId }) => cardId));
  return [...current, ...removed.filter(({ cardId }) => !present.has(cardId))];
}

/**
 * Read the stacking lookup returned by a layer move. If absent or invalid, preserve existing
 * card zIndex values.
 */
function readStacking(parsed: unknown): Map<string, number> {
  const stacking = readArray(parsed, "stacking");
  if (!stacking) return new Map();
  return new Map(
    stacking.flatMap((entry) => {
      const cardId = readString(entry, "cardId");
      const zIndex = readFiniteNumber(entry, "zIndex");
      return cardId !== undefined && zIndex !== undefined ? [[cardId, zIndex] as const] : [];
    }),
  );
}

export function createNamespaceActions(state: NamespaceState) {
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
    const zIndexByCardId = readStacking(parsed);
    state.cards = [
      ...state.cards
        .filter((c) => c.id !== cardId)
        .map((c) => {
          const zIndex = zIndexByCardId.get(c.id);
          return zIndex === undefined ? c : { ...c, zIndex };
        }),
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

  async function handleCreatePartition() {
    const name = state.sidebar.newPartitionName.trim();
    if (!name) return;
    const res = await api.createPartition(state.mutationFetcher, state.namespaceId, name);
    if (!res.ok) {
      state.setError("Failed to create partition");
      return;
    }
    const id = readString(await res.json().catch(() => null), "id");
    if (id === undefined) {
      state.setError("Failed to create partition");
      return;
    }
    state.partitions = [
      ...state.partitions,
      { id, namespaceId: state.namespaceId, name, isDefault: false },
    ];
    state.sidebar.newPartitionName = "";
  }

  async function handleDeletePartition(partitionId: string) {
    const res = await api.deletePartition(state.mutationFetcher, state.namespaceId, partitionId);
    if (!res.ok) {
      state.setError("Failed to delete partition");
      return;
    }
    const defaultPartitionId = readString(await res.json().catch(() => null), "defaultPartitionId");
    if (defaultPartitionId === undefined) {
      state.setError("Failed to delete partition");
      return;
    }
    state.cards = state.cards.map((c) =>
      c.partitionId === partitionId ? { ...c, partitionId: defaultPartitionId } : c,
    );
    state.partitions = state.partitions.filter((b) => b.id !== partitionId);
    if (state.sidebar.activePartition === partitionId) state.sidebar.activePartition = null;
  }

  async function handleCreateLayer(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api.createLayer(state.mutationFetcher, state.namespaceId, trimmed);
    if (!res.ok) {
      // The server's own wording carries the reason a name was refused ("A layer named
      // 'Draft' already exists"), which a fixed banner would throw away.
      state.setError(await api.failureMessage(res, "Failed to create layer"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    const id = readString(parsed, "id");
    const position = readFiniteNumber(parsed, "position");
    if (id === undefined || position === undefined) {
      state.setError("Failed to create layer");
      return;
    }
    state.layers = [
      ...state.layers,
      { id, namespaceId: state.namespaceId, name: trimmed, position, isDefault: false },
    ];
    // A layer is created to be drawn on, so it becomes the one new cards land on.
    state.activeLayerId = id;
  }

  async function handleDeleteLayer(layerId: string) {
    const res = await api.deleteLayer(state.mutationFetcher, state.namespaceId, layerId);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to delete layer"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    const defaultLayerId = readString(parsed, "defaultLayerId");
    if (defaultLayerId === undefined) {
      state.setError("Failed to delete layer");
      return;
    }
    // The server restacks the moved cards above the default layer's cards.
    const stacking = readStacking(parsed);
    state.cards = state.cards.map((c) =>
      c.layerId === layerId
        ? { ...c, layerId: defaultLayerId, zIndex: stacking.get(c.id) ?? c.zIndex }
        : c,
    );
    state.layers = state.layers.filter((l) => l.id !== layerId);
    if (state.activeLayerId === layerId) state.activeLayerId = defaultLayerId;
  }

  async function handleSetWarp(position: { posX: number; posY: number }) {
    const res = await api.createWarp(state.mutationFetcher, state.namespaceId, position);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to set warp"));
      return;
    }
    // Use the stored warp position because the server clamps it to the canvas.
    const parsed = api.parseWarp(await res.json().catch(() => null));
    if (!parsed) {
      state.setError("Failed to set warp");
      return;
    }
    state.warps = [...state.warps, parsed];
    state.focusedWarpId = parsed.id;
  }

  async function handleRemoveWarp(warpId: string) {
    const prevWarps = state.warps;
    const prevFocused = state.focusedWarpId;
    state.warps = state.warps.filter((w) => w.id !== warpId);
    if (state.focusedWarpId === warpId) state.focusedWarpId = null;
    const res = await api.deleteWarp(state.mutationFetcher, state.namespaceId, warpId);
    if (!res.ok) {
      state.warps = prevWarps;
      state.focusedWarpId = prevFocused;
      state.setError(await api.failureMessage(res, "Failed to remove warp"));
    }
  }

  async function handleRenameLayer(layerId: string, name: string) {
    const trimmed = name.trim();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!trimmed || !layer || layer.name === trimmed) return;
    const prevLayers = state.layers;
    state.layers = state.layers.map((l) => (l.id === layerId ? { ...l, name: trimmed } : l));
    const res = await api.renameLayer(state.mutationFetcher, state.namespaceId, layerId, trimmed);
    if (!res.ok) {
      state.layers = prevLayers;
      state.setError(await api.failureMessage(res, "Failed to rename layer"));
    }
  }

  /** `layerIds` is the namespace's full layer ordering, bottom to top. */
  async function handleReorderLayers(layerIds: string[]) {
    const prevLayers = state.layers;
    const byId = new Map(prevLayers.map((l) => [l.id, l]));
    if (layerIds.length !== prevLayers.length || layerIds.some((id) => !byId.has(id))) return;
    state.layers = layerIds.map((id, position) => ({ ...byId.get(id)!, position }));
    const res = await api.reorderLayers(state.mutationFetcher, state.namespaceId, layerIds);
    if (!res.ok) {
      state.layers = prevLayers;
      // Show the server's reorder guidance when layers changed elsewhere.
      state.setError(await api.failureMessage(res, "Failed to reorder layers"));
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
    const zIndexByCardId = readStacking(parsed);
    if (zIndexByCardId.size > 0) {
      state.cards = state.cards.map((c) => {
        const zIndex = zIndexByCardId.get(c.id);
        return zIndex === undefined ? c : { ...c, zIndex };
      });
    }
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
    const zIndexByCardId = readStacking(parsed);
    state.cards = state.cards.map((c) => {
      const zIndex = zIndexByCardId.get(c.id);
      return zIndex === undefined ? c : { ...c, zIndex };
    });
  }

  async function handleCreateScope() {
    const name = state.sidebar.newScopeName.trim();
    if (!name) return;
    const res = await api.createScope(state.mutationFetcher, state.namespaceId, name);
    if (!res.ok) {
      state.setError("Failed to create scope");
      return;
    }
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to create scope");
      return;
    }
    state.scopes = [...state.scopes, { id: parsed.id, name }];
    state.sidebar.newScopeName = "";
  }

  async function handleCreateTaskspace() {
    const name = state.sidebar.newWcName.trim();
    if (!state.sidebar.activeScope) {
      state.setError("Select a scope before creating a taskspace");
      return;
    }
    if (!name) return;
    const made = await createTaskspace(state.sidebar.activeScope, name);
    if ("error" in made) {
      state.setError("Failed to create taskspace");
      return;
    }
    state.sidebar.newWcName = "";
  }

  /**
   * Create a taskspace directory in a scope and add it to the board. Return the server's
   * reason on failure so callers with their own name field, such as scope frames, can show it
   * there instead of in the banner.
   */
  async function createTaskspace(
    scopeId: string,
    rawName: string,
  ): Promise<{ id: string } | { error: string }> {
    const name = rawName.trim();
    if (!name) return { error: "Taskspace name is required" };
    const res = await api.createTaskspace(state.mutationFetcher, state.namespaceId, {
      name,
      scopeId,
    });
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to create taskspace") };
    const parsed = await res.json().catch(() => null);
    const id = readString(parsed, "id");
    if (id === undefined) return { error: "Failed to create taskspace" };
    state.taskspaces = [
      ...state.taskspaces,
      { id, name, scopeId, path: parsed.path, pathKind: parsed.pathKind },
    ];
    return { id };
  }

  async function handleDeleteScope(scopeId: string) {
    const prevScopes = state.scopes;
    const prevScopeRels = state.scopeRels;
    const prevActiveScope = state.sidebar.activeScope;

    state.scopes = state.scopes.filter((s) => s.id !== scopeId);
    state.scopeRels = state.scopeRels.filter((r) => r.scopeId !== scopeId);
    if (state.sidebar.activeScope === scopeId) state.sidebar.activeScope = null;

    const res = await api.deleteScope(state.mutationFetcher, state.namespaceId, scopeId);
    if (!res.ok) {
      state.scopes = prevScopes;
      state.scopeRels = prevScopeRels;
      state.sidebar.activeScope = prevActiveScope;
      state.setError("Failed to delete scope");
    }
  }

  async function handleAddToScope(scopeId: string) {
    if (state.selection.selectedCards.size === 0) return;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.addCardsToScope(
      state.mutationFetcher,
      state.namespaceId,
      scopeId,
      cardIds,
    );
    if (!res.ok) {
      state.setError("Failed to add cards to scope");
      return;
    }
    const newRels = cardIds
      .filter((cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
      .map((cardId) => ({ scopeId, cardId }));
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to add cards to scope");
      return;
    }
    state.scopeRels = [...state.scopeRels, ...newRels];
    state.selection.selectedCards = new Set();
  }

  /**
   * Add selected cards to a scope without clearing the selection used by the file palette.
   * Return whether linking succeeded.
   */
  async function handleLinkScope(scopeId: string): Promise<boolean> {
    if (state.selection.selectedCards.size === 0) return false;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.addCardsToScope(
      state.mutationFetcher,
      state.namespaceId,
      scopeId,
      cardIds,
    );
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to link cards to scope"));
      return false;
    }
    state.scopeRels = [
      ...state.scopeRels,
      ...cardIds
        .filter((cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
        .map((cardId) => ({ scopeId, cardId })),
    ];
    return true;
  }

  /**
   * Create a scope, taskspace, and empty file, then link selected cards. Preserve server
   * error messages for each step.
   *
   * If taskspace creation fails, remove the newly created scope. After that step, retain
   * created resources so the user can finish through existing controls. Return the file to
   * open, or null.
   */
  async function handleCreateScopeWithFile(names: {
    scope: string;
    taskspace: string;
    file: string;
  }): Promise<{ taskspaceId: string; taskspaceName: string; path: string } | null> {
    const scopeName = names.scope.trim();
    const taskspaceName = names.taskspace.trim();
    const fileName = names.file.trim();
    if (!scopeName || !taskspaceName || !fileName) {
      state.setError("A scope, taskspace, and file name are all required");
      return null;
    }

    const scopeRes = await api.createScope(state.mutationFetcher, state.namespaceId, scopeName);
    const scope = scopeRes.ok ? await scopeRes.json().catch(() => null) : null;
    const scopeId = readString(scope, "id");
    if (scopeId === undefined) {
      state.setError(await api.failureMessage(scopeRes, "Failed to create scope"));
      return null;
    }
    state.scopes = [...state.scopes, { id: scopeId, name: scopeName }];

    const taskspaceRes = await api.createTaskspace(state.mutationFetcher, state.namespaceId, {
      name: taskspaceName,
      scopeId,
    });
    const taskspace = taskspaceRes.ok ? await taskspaceRes.json().catch(() => null) : null;
    const taskspaceId = readString(taskspace, "id");
    if (taskspaceId === undefined) {
      const message = await api.failureMessage(taskspaceRes, "Failed to create taskspace");
      // Remove the scope created for this failed taskspace. If cleanup also fails, leave it
      // available for deletion in the sidebar.
      await api.deleteScope(state.mutationFetcher, state.namespaceId, scopeId);
      state.scopes = state.scopes.filter((existing) => existing.id !== scopeId);
      state.setError(message);
      return null;
    }
    state.taskspaces = [
      ...state.taskspaces,
      {
        id: taskspaceId,
        name: taskspaceName,
        scopeId,
        path: taskspace.path,
        pathKind: taskspace.pathKind,
      },
    ];

    const fileRes = await api.createTaskspaceFile(
      state.mutationFetcher,
      state.namespaceId,
      taskspaceId,
      fileName,
    );
    const file = fileRes.ok ? await fileRes.json().catch(() => null) : null;
    if (typeof file?.path !== "string") {
      state.setError(await api.failureMessage(fileRes, "Failed to create file"));
      return null;
    }

    // Link membership last to avoid undoing it if creation fails. Report link failures but
    // still open the created file.
    await handleLinkScope(scopeId);

    return { taskspaceId, taskspaceName, path: file.path };
  }

  async function handleRemoveFromScope(scopeId: string) {
    if (state.selection.selectedCards.size === 0) return;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.removeCardsFromScope(
      state.mutationFetcher,
      state.namespaceId,
      scopeId,
      cardIds,
    );
    if (!res.ok) {
      state.setError("Failed to remove cards from scope");
      return;
    }
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to remove cards from scope");
      return;
    }
    const removed = new Set(cardIds);
    state.scopeRels = state.scopeRels.filter(
      (r) => !(r.scopeId === scopeId && removed.has(r.cardId)),
    );
    state.selection.selectedCards = new Set();
  }

  /**
   * Apply membership changes for cards crossing frame boundaries. Handle entry and exit
   * requests independently, rolling back only the failed half. Preserve the current
   * selection.
   */
  async function handleScopeMembershipChange(
    scopeId: string,
    { entered, exited }: { entered: string[]; exited: string[] },
  ) {
    if (entered.length > 0) {
      const added = entered.filter(
        (cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid),
      );
      state.scopeRels = [...state.scopeRels, ...added.map((cardId) => ({ scopeId, cardId }))];
      const res = await api.addCardsToScope(
        state.mutationFetcher,
        state.namespaceId,
        scopeId,
        entered,
      );
      if (!res.ok) {
        const addedSet = new Set(added);
        state.scopeRels = state.scopeRels.filter(
          (r) => !(r.scopeId === scopeId && addedSet.has(r.cardId)),
        );
        state.setError(await api.failureMessage(res, "Failed to add cards to scope"));
      }
    }

    if (exited.length > 0) {
      const exitedSet = new Set(exited);
      const removed = state.scopeRels.filter(
        (r) => r.scopeId === scopeId && exitedSet.has(r.cardId),
      );
      state.scopeRels = state.scopeRels.filter(
        (r) => !(r.scopeId === scopeId && exitedSet.has(r.cardId)),
      );
      const res = await api.removeCardsFromScope(
        state.mutationFetcher,
        state.namespaceId,
        scopeId,
        exited,
      );
      if (!res.ok) {
        state.scopeRels = [...state.scopeRels, ...removed];
        state.setError(await api.failureMessage(res, "Failed to remove cards from scope"));
      }
    }
  }

  /**
   * Create a scope frame at the supplied rectangle and add the supplied overlapping cards to
   * the scope. The caller provides geometry and measured members.
   */
  async function handleCreateScopeArea(scopeId: string, rect: BoardRect, covers: string[] = []) {
    const res = await api.createScopeArea(state.mutationFetcher, state.namespaceId, scopeId, rect);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to add scope area"));
      return;
    }
    const stored = api.parseScopeArea(await res.json().catch(() => null));
    if (!stored) {
      state.setError("Failed to add scope area");
      return;
    }
    // Append the new frame without replacing other frames for this scope.
    state.scopeAreas = [...state.scopeAreas, stored];
    if (covers.length > 0) {
      await handleScopeMembershipChange(scopeId, { entered: covers, exited: [] });
    }
  }

  /**
   * Create a named scope, then frame it. Keep the scope if frame creation fails so the user
   * can retry placement.
   */
  async function handleCreateScopeWithArea(name: string, rect: BoardRect, covers: string[] = []) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api.createScope(state.mutationFetcher, state.namespaceId, trimmed);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to create scope"));
      return;
    }
    const scopeId = readString(await res.json().catch(() => null), "id");
    if (scopeId === undefined) {
      state.setError("Failed to create scope");
      return;
    }
    state.scopes = [...state.scopes, { id: scopeId, name: trimmed }];
    await handleCreateScopeArea(scopeId, rect, covers);
  }

  /** Remove the frame while preserving all scope memberships. */
  async function handleDeleteScopeArea(scopeId: string, areaId: string) {
    const prev = state.scopeAreas;
    // Remove only the clicked frame's area ID.
    state.scopeAreas = state.scopeAreas.filter((a) => a.id !== areaId);
    const res = await api.deleteScopeArea(
      state.mutationFetcher,
      state.namespaceId,
      scopeId,
      areaId,
    );
    if (!res.ok) {
      state.scopeAreas = prev;
      state.setError("Failed to remove scope area");
    }
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
    handleCreatePartition,
    handleDeletePartition,
    handleCreateLayer,
    handleDeleteLayer,
    handleRenameLayer,
    handleReorderLayers,
    handleSelectionLayerChange,
    handleStackOrderChange,
    handleSetWarp,
    handleRemoveWarp,
    handleCreateScope,
    handleDeleteScope,
    handleAddToScope,
    handleRemoveFromScope,
    handleCreateTaskspace,
    createTaskspace,
    handleLinkScope,
    handleCreateScopeWithFile,
    handleScopeMembershipChange,
    handleCreateScopeArea,
    handleCreateScopeWithArea,
    handleDeleteScopeArea,
  };
}
