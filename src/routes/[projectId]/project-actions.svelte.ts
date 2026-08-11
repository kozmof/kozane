import * as api from "./lib/project-api";
import type { ProjectState } from "./project-state.svelte.js";

/**
 * The `stacking` a layer move answers with, as a lookup. Read defensively: an older
 * server, or a static export replaying a canned response, simply reports nothing and the
 * cards keep the zIndex they had.
 */
function readStacking(parsed: unknown): Map<string, number> {
  const stacking = (parsed as { stacking?: unknown } | null)?.stacking;
  if (!Array.isArray(stacking)) return new Map();
  return new Map(
    stacking.flatMap((entry: unknown) => {
      const { cardId, zIndex } = (entry ?? {}) as { cardId?: unknown; zIndex?: unknown };
      return typeof cardId === "string" && typeof zIndex === "number"
        ? [[cardId, zIndex] as const]
        : [];
    }),
  );
}

export function createProjectActions(state: ProjectState) {
  async function handleCardBundleChange(newBundleId: string) {
    if (!state.selection.composerCard) return;
    const cardId = state.selection.composerCard.id;
    const prevCards = state.cards;
    state.cards = state.cards.map((c) => (c.id === cardId ? { ...c, bundleId: newBundleId } : c));
    const res = await api.updateCard(state.mutationFetcher, state.projectId, cardId, {
      bundleId: newBundleId,
    });
    if (!res.ok) {
      state.cards = prevCards;
      state.setError("Failed to change bundle");
    }
  }

  async function handleSelectionBundleChange(cardIds: string[], newBundleId: string) {
    const prevCards = state.cards;
    state.cards = state.cards.map((c) =>
      cardIds.includes(c.id) ? { ...c, bundleId: newBundleId } : c,
    );
    const res = await api.batchReassignBundle(
      state.mutationFetcher,
      state.projectId,
      cardIds,
      newBundleId,
    );
    if (!res.ok) {
      state.cards = prevCards;
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
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to glue cards");
      return;
    }
    const { glueId } = parsed;
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
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError(errorMsg);
      return;
    }
    const clearedSet = new Set<string>(parsed.clearedCardIds);
    state.glueRels = state.glueRels.filter((r) => !clearedSet.has(r.cardId));
    state.cards = state.cards.map((c) => (clearedSet.has(c.id) ? { ...c, glueId: null } : c));
  }

  async function handleUnglueOne(cardId: string) {
    await unglue([cardId], "Failed to unglue card");
  }

  async function handleUnglueSelected(cardIds: string[]) {
    await unglue(cardIds, "Failed to unglue cards");
  }

  async function handleDeleteSelected(cardIds: string[]) {
    const cardIdSet = new Set(cardIds);
    const prevCards = state.cards;
    const prevGlueRels = state.glueRels;
    const prevSelectedCards = state.selection.selectedCards;
    const prevPrimarySelectedId = state.selection.primarySelectedId;

    state.cards = state.cards.filter((c) => !cardIdSet.has(c.id));
    state.glueRels = state.glueRels.filter((r) => !cardIdSet.has(r.cardId));
    state.selection.selectedCards = new Set(
      [...state.selection.selectedCards].filter((id) => !cardIdSet.has(id)),
    );
    const pid = state.selection.primarySelectedId;
    if (pid !== null && cardIdSet.has(pid)) state.selection.primarySelectedId = null;

    const res = await api.deleteCards(state.mutationFetcher, state.projectId, cardIds);
    if (!res.ok) {
      state.cards = prevCards;
      state.glueRels = prevGlueRels;
      state.selection.selectedCards = prevSelectedCards;
      state.selection.primarySelectedId = prevPrimarySelectedId;
      state.setError("Failed to delete cards");
    }
  }

  async function handleMoveSelectionToProject(cardIds: string[], targetProjectId: string) {
    const cardIdSet = new Set(cardIds);
    const prevCards = state.cards;
    const prevGlueRels = state.glueRels;
    const prevSelectedCards = state.selection.selectedCards;
    const prevPrimarySelectedId = state.selection.primarySelectedId;

    state.cards = state.cards.filter((c) => !cardIdSet.has(c.id));
    state.glueRels = state.glueRels.filter((r) => !cardIdSet.has(r.cardId));
    state.selection.selectedCards = new Set(
      [...state.selection.selectedCards].filter((id) => !cardIdSet.has(id)),
    );
    const pid = state.selection.primarySelectedId;
    if (pid !== null && cardIdSet.has(pid)) state.selection.primarySelectedId = null;

    const res = await api.moveCardsToProject(
      state.mutationFetcher,
      state.projectId,
      cardIds,
      targetProjectId,
    );
    if (!res.ok) {
      state.cards = prevCards;
      state.glueRels = prevGlueRels;
      state.selection.selectedCards = prevSelectedCards;
      state.selection.primarySelectedId = prevPrimarySelectedId;
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
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to create bundle");
      return;
    }
    state.bundles = [
      ...state.bundles,
      { id: parsed.id, projectId: state.projectId, name, isDefault: false },
    ];
    state.sidebar.newBundleName = "";
  }

  async function handleDeleteBundle(bundleId: string) {
    const res = await api.deleteBundle(state.mutationFetcher, state.projectId, bundleId);
    if (!res.ok) {
      state.setError("Failed to delete bundle");
      return;
    }
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to delete bundle");
      return;
    }
    state.cards = state.cards.map((c) =>
      c.bundleId === bundleId ? { ...c, bundleId: parsed.defaultBundleId } : c,
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
    if (!parsed) {
      state.setError("Failed to create layer");
      return;
    }
    state.layers = [
      ...state.layers,
      {
        id: parsed.id,
        projectId: state.projectId,
        name: trimmed,
        position: parsed.position,
        isDefault: false,
      },
    ];
    // A layer is created to be drawn on, so it becomes the one new cards land on.
    state.activeLayerId = parsed.id;
  }

  async function handleDeleteLayer(layerId: string) {
    const res = await api.deleteLayer(state.mutationFetcher, state.projectId, layerId);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to delete layer"));
      return;
    }
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to delete layer");
      return;
    }
    state.cards = state.cards.map((c) =>
      c.layerId === layerId ? { ...c, layerId: parsed.defaultLayerId } : c,
    );
    state.layers = state.layers.filter((l) => l.id !== layerId);
    if (state.activeLayerId === layerId) state.activeLayerId = parsed.defaultLayerId;
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
    const prevCards = state.cards;
    state.cards = state.cards.map((c) => (cardIds.includes(c.id) ? { ...c, layerId } : c));
    const res = await api.batchReassignLayer(
      state.mutationFetcher,
      state.projectId,
      cardIds,
      layerId,
    );
    if (!res.ok) {
      state.cards = prevCards;
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
    handleMoveSelectionToProject,
    handleCreateBundle,
    handleDeleteBundle,
    handleCreateLayer,
    handleDeleteLayer,
    handleRenameLayer,
    handleReorderLayers,
    handleSelectionLayerChange,
    handleCreateScope,
    handleDeleteScope,
    handleAddToScope,
    handleRemoveFromScope,
    handleCreateTaskspace,
  };
}
