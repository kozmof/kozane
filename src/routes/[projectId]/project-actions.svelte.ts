import * as api from "./lib/project-api.js";
import type { CardWithGlue, GlueRel } from "$lib/types";
import type { ProjectState } from "./project-state.svelte.js";
import { readArray, readFiniteNumber, readString, readStringArray } from "./lib/response.js";

/**
 * Undoing an optimistic edit, by field and by card rather than by restoring the array the
 * edit started from.
 *
 * The whole-array form was wrong whenever two edits overlapped. Each one captured
 * `state.cards` before its request and put that copy back on failure, so a rollback also
 * reverted every change applied in the meantime — a card moved to another bundle would
 * silently jump back because an unrelated delete failed. The poll is held off while a
 * mutation is pending (`ProjectState.mutationFetcher`), but nothing serializes the user's
 * own clicks, and the second edit is the one that loses.
 *
 * These are applied against whatever the board holds at the moment the failure lands, so
 * an edit that succeeded alongside is left where it is.
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
 * Puts removed rows back, skipping any the board has since regained. They land at the end
 * rather than where they were, which changes nothing on the canvas: cards are stacked by
 * `zIndex` within their layer, not by their place in this list — `handleSquashCard`
 * already appends for the same reason.
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
 * The `stacking` a layer move answers with, as a lookup. Read defensively: an older
 * server, or a static export replaying a canned response, simply reports nothing and the
 * cards keep the zIndex they had.
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

export function createProjectActions(state: ProjectState) {
  async function handleCardBundleChange(newBundleId: string) {
    if (!state.selection.composerCard) return;
    const cardId = state.selection.composerCard.id;
    const previous = fieldSnapshot(state.cards, [cardId], "bundleId");
    state.cards = state.cards.map((c) => (c.id === cardId ? { ...c, bundleId: newBundleId } : c));
    const res = await api.updateCard(state.mutationFetcher, state.projectId, cardId, {
      bundleId: newBundleId,
    });
    if (!res.ok) {
      state.cards = restoreField(state.cards, "bundleId", previous);
      state.setError("Failed to change bundle");
    }
  }

  async function handleSelectionBundleChange(cardIds: string[], newBundleId: string) {
    const previous = fieldSnapshot(state.cards, cardIds, "bundleId");
    const moving = new Set(cardIds);
    state.cards = state.cards.map((c) => (moving.has(c.id) ? { ...c, bundleId: newBundleId } : c));
    const res = await api.batchReassignBundle(
      state.mutationFetcher,
      state.projectId,
      cardIds,
      newBundleId,
    );
    if (!res.ok) {
      state.cards = restoreField(state.cards, "bundleId", previous);
      state.setError("Failed to change bundle for selected cards");
    }
  }

  // Glue/unglue and scope membership apply their changes only after the server
  // confirms them, so a failure needs no rollback — nothing was changed locally.
  async function handleGlueSelected(cardIds: string[]) {
    const res = await api.glueCards(state.mutationFetcher, state.projectId, cardIds);
    if (!res.ok) {
      state.setError("Failed to glue cards");
      return;
    }
    const glueId = readString(await res.json().catch(() => null), "glueId");
    if (glueId === undefined) {
      state.setError("Failed to glue cards");
      return;
    }
    state.glueRels = [
      ...state.glueRels.filter((r) => !cardIds.includes(r.cardId)),
      ...cardIds.map((cardId) => ({ glueId, cardId })),
    ];
    state.cards = state.cards.map((c) => (cardIds.includes(c.id) ? { ...c, glueId } : c));
  }

  async function unglue(cardIds: string[], errorMsg: string) {
    const res = await api.unglueCards(state.mutationFetcher, state.projectId, cardIds);
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
   * Takes cards off the board before the server has confirmed they are gone, and hands
   * back the undo for it. Delete and move-to-project do exactly the same thing here and
   * differ only in the request they make and in what they say when it fails.
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
      // Only when nothing has claimed it since: the user may have picked another card while
      // the request was in flight, and that choice is newer than this undo.
      if (wasPrimary && state.selection.primarySelectedId === null)
        state.selection.primarySelectedId = wasPrimary;
    };
  }

  async function handleDeleteSelected(cardIds: string[]) {
    const undo = removeCardsOptimistically(cardIds);
    const res = await api.deleteCards(state.mutationFetcher, state.projectId, cardIds);
    if (!res.ok) {
      undo();
      state.setError("Failed to delete cards");
    }
  }

  /**
   * Splits a card into one card per segment of its text. Applied only once the server
   * confirms it, the way glue and scope membership are: the pieces come back with the
   * positions and ids the server gave them, and nothing local was changed to roll back.
   */
  async function handleSquashCard(cardId: string) {
    const res = await api.squashCard(state.mutationFetcher, state.projectId, cardId);
    if (!res.ok) {
      // The server's own wording says which card it refused and why — "does not split into
      // more than one card" is the part that tells the user to pick a different card.
      state.setError(await api.failureMessage(res, "Failed to squash card"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    const cards = (parsed as { cards?: unknown } | null)?.cards;
    if (!Array.isArray(cards) || cards.length === 0) {
      state.setError("Failed to squash card");
      return;
    }
    state.cards = [...state.cards.filter((c) => c.id !== cardId), ...cards];
    state.glueRels = state.glueRels.filter((r) => r.cardId !== cardId);
    // The pieces inherit the card's scope memberships server-side, so the sidebar's counts
    // follow them here rather than waiting a poll to catch up.
    const scopeIds = state.scopeRels.filter((r) => r.cardId === cardId).map((r) => r.scopeId);
    state.scopeRels = [
      ...state.scopeRels.filter((r) => r.cardId !== cardId),
      ...scopeIds.flatMap((scopeId) => cards.map((c) => ({ scopeId, cardId: c.id }))),
    ];
    // The pieces are what there is to work on now: the card that was selected is gone, and
    // leaving the selection empty would drop the action bar the squash was started from.
    state.selection.selectedCards = new Set<string>(cards.map((c) => c.id));
    state.selection.primarySelectedId = cards[0].id;
    state.selection.composerCard = null;
    state.selection.resizingCardId = null;
  }

  async function handleMoveSelectionToProject(cardIds: string[], targetProjectId: string) {
    const undo = removeCardsOptimistically(cardIds);
    const res = await api.moveCardsToProject(
      state.mutationFetcher,
      state.projectId,
      cardIds,
      targetProjectId,
    );
    if (!res.ok) {
      undo();
      state.setError("Failed to move cards to project");
    }
  }

  async function handleCreateBundle() {
    const name = state.sidebar.newBundleName.trim();
    if (!name) return;
    const res = await api.createBundle(state.mutationFetcher, state.projectId, name);
    if (!res.ok) {
      state.setError("Failed to create bundle");
      return;
    }
    const id = readString(await res.json().catch(() => null), "id");
    if (id === undefined) {
      state.setError("Failed to create bundle");
      return;
    }
    state.bundles = [...state.bundles, { id, projectId: state.projectId, name, isDefault: false }];
    state.sidebar.newBundleName = "";
  }

  async function handleDeleteBundle(bundleId: string) {
    const res = await api.deleteBundle(state.mutationFetcher, state.projectId, bundleId);
    if (!res.ok) {
      state.setError("Failed to delete bundle");
      return;
    }
    const defaultBundleId = readString(await res.json().catch(() => null), "defaultBundleId");
    if (defaultBundleId === undefined) {
      state.setError("Failed to delete bundle");
      return;
    }
    state.cards = state.cards.map((c) =>
      c.bundleId === bundleId ? { ...c, bundleId: defaultBundleId } : c,
    );
    state.bundles = state.bundles.filter((b) => b.id !== bundleId);
    if (state.sidebar.activeBundle === bundleId) state.sidebar.activeBundle = null;
  }

  async function handleCreateLayer(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api.createLayer(state.mutationFetcher, state.projectId, trimmed);
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
      { id, projectId: state.projectId, name: trimmed, position, isDefault: false },
    ];
    // A layer is created to be drawn on, so it becomes the one new cards land on.
    state.activeLayerId = id;
  }

  async function handleDeleteLayer(layerId: string) {
    const res = await api.deleteLayer(state.mutationFetcher, state.projectId, layerId);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to delete layer"));
      return;
    }
    const defaultLayerId = readString(await res.json().catch(() => null), "defaultLayerId");
    if (defaultLayerId === undefined) {
      state.setError("Failed to delete layer");
      return;
    }
    state.cards = state.cards.map((c) =>
      c.layerId === layerId ? { ...c, layerId: defaultLayerId } : c,
    );
    state.layers = state.layers.filter((l) => l.id !== layerId);
    if (state.activeLayerId === layerId) state.activeLayerId = defaultLayerId;
  }

  async function handleSetWarp(position: { posX: number; posY: number }) {
    const res = await api.createWarp(state.mutationFetcher, state.projectId, position);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to set warp"));
      return;
    }
    // The stored row, not the position sent: the server clamps it to the canvas, so a
    // warp set at the very edge would otherwise move on the next poll.
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
    const res = await api.deleteWarp(state.mutationFetcher, state.projectId, warpId);
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
    const res = await api.renameLayer(state.mutationFetcher, state.projectId, layerId, trimmed);
    if (!res.ok) {
      state.layers = prevLayers;
      state.setError(await api.failureMessage(res, "Failed to rename layer"));
    }
  }

  /** `layerIds` is the project's full layer ordering, bottom to top. */
  async function handleReorderLayers(layerIds: string[]) {
    const prevLayers = state.layers;
    const byId = new Map(prevLayers.map((l) => [l.id, l]));
    if (layerIds.length !== prevLayers.length || layerIds.some((id) => !byId.has(id))) return;
    state.layers = layerIds.map((id, position) => ({ ...byId.get(id)!, position }));
    const res = await api.reorderLayers(state.mutationFetcher, state.projectId, layerIds);
    if (!res.ok) {
      state.layers = prevLayers;
      // A reorder fails when someone else changed the layers, and the server says so —
      // "reload to see the current order" is the part the user needs.
      state.setError(await api.failureMessage(res, "Failed to reorder layers"));
    }
  }

  async function handleSelectionLayerChange(cardIds: string[], layerId: string) {
    const previous = fieldSnapshot(state.cards, cardIds, "layerId");
    const moving = new Set(cardIds);
    state.cards = state.cards.map((c) => (moving.has(c.id) ? { ...c, layerId } : c));
    const res = await api.batchReassignLayer(
      state.mutationFetcher,
      state.projectId,
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
    // Moving cards is how you follow them: the layer they landed on becomes the one in front.
    state.activeLayerId = layerId;
  }

  async function handleCreateScope() {
    const name = state.sidebar.newScopeName.trim();
    if (!name) return;
    const res = await api.createScope(state.mutationFetcher, state.projectId, name);
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
    const scopeId = state.sidebar.activeScope;
    const res = await api.createTaskspace(state.mutationFetcher, state.projectId, {
      name,
      scopeId,
    });
    if (!res.ok) {
      state.setError("Failed to create taskspace");
      return;
    }
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to create taskspace");
      return;
    }
    state.taskspaces = [
      ...state.taskspaces,
      { id: parsed.id, name, scopeId, path: parsed.path, pathKind: parsed.pathKind },
    ];
    state.sidebar.newWcName = "";
  }

  async function handleDeleteScope(scopeId: string) {
    const prevScopes = state.scopes;
    const prevScopeRels = state.scopeRels;
    const prevActiveScope = state.sidebar.activeScope;

    state.scopes = state.scopes.filter((s) => s.id !== scopeId);
    state.scopeRels = state.scopeRels.filter((r) => r.scopeId !== scopeId);
    if (state.sidebar.activeScope === scopeId) state.sidebar.activeScope = null;

    const res = await api.deleteScope(state.mutationFetcher, state.projectId, scopeId);
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
    const res = await api.addCardsToScope(state.mutationFetcher, state.projectId, scopeId, cardIds);
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

  async function handleRemoveFromScope(scopeId: string) {
    if (state.selection.selectedCards.size === 0) return;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.removeCardsFromScope(
      state.mutationFetcher,
      state.projectId,
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
    state.scopeRels = state.scopeRels.filter(
      (r) => !(r.scopeId === scopeId && cardIds.includes(r.cardId)),
    );
    state.selection.selectedCards = new Set();
  }

  return {
    handleCardBundleChange,
    handleSelectionBundleChange,
    handleGlueSelected,
    handleUnglueOne,
    handleUnglueSelected,
    handleDeleteSelected,
    handleSquashCard,
    handleMoveSelectionToProject,
    handleCreateBundle,
    handleDeleteBundle,
    handleCreateLayer,
    handleDeleteLayer,
    handleRenameLayer,
    handleReorderLayers,
    handleSelectionLayerChange,
    handleSetWarp,
    handleRemoveWarp,
    handleCreateScope,
    handleDeleteScope,
    handleAddToScope,
    handleRemoveFromScope,
    handleCreateTaskspace,
  };
}
