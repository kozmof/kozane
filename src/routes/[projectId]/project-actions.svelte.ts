import * as api from "./lib/project-api";
import type { ProjectState } from "./project-state.svelte.js";

export function createProjectActions(state: ProjectState) {
  async function handleCardBundleChange(newBundleId: string) {
    if (!state.selection.composerCard) return;
    const cardId = state.selection.composerCard.id;
    const prevCards = state.cards;
    state.cards = state.cards.map((c) => (c.id === cardId ? { ...c, bundleId: newBundleId } : c));
    const res = await api.updateCard(state.fetcher, state.projectId, cardId, {
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
    const res = await api.batchReassignBundle(state.fetcher, state.projectId, cardIds, newBundleId);
    if (!res.ok) {
      state.cards = prevCards;
      state.setError("Failed to change bundle for selected cards");
    }
  }

  async function handleGlueSelected(cardIds: string[]) {
    const res = await api.glueCards(state.fetcher, state.projectId, cardIds);
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
    const res = await api.unglueCards(state.fetcher, state.projectId, cardIds);
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
    const res = await api.deleteCards(state.fetcher, state.projectId, cardIds);
    if (!res.ok) {
      state.setError("Failed to delete cards");
      return;
    }
    const cardIdSet = new Set(cardIds);
    state.cards = state.cards.filter((c) => !cardIdSet.has(c.id));
    state.glueRels = state.glueRels.filter((r) => !cardIdSet.has(r.cardId));
    state.selection.selectedCards = new Set(
      [...state.selection.selectedCards].filter((id) => !cardIdSet.has(id)),
    );
    const pid = state.selection.primarySelectedId;
    if (pid !== null && cardIdSet.has(pid)) state.selection.primarySelectedId = null;
  }

  async function handleMoveSelectionToProject(cardIds: string[], targetProjectId: string) {
    const res = await api.moveCardsToProject(
      state.fetcher,
      state.projectId,
      cardIds,
      targetProjectId,
    );
    if (!res.ok) {
      state.setError("Failed to move cards to project");
      return;
    }
    const cardIdSet = new Set(cardIds);
    state.cards = state.cards.filter((c) => !cardIdSet.has(c.id));
    state.glueRels = state.glueRels.filter((r) => !cardIdSet.has(r.cardId));
    state.selection.selectedCards = new Set(
      [...state.selection.selectedCards].filter((id) => !cardIdSet.has(id)),
    );
    const pid = state.selection.primarySelectedId;
    if (pid !== null && cardIdSet.has(pid)) state.selection.primarySelectedId = null;
  }

  async function handleCreateBundle() {
    const name = state.sidebar.newBundleName.trim();
    if (!name) return;
    const res = await api.createBundle(state.fetcher, state.projectId, name);
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
    const res = await api.deleteBundle(state.fetcher, state.projectId, bundleId);
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

  async function handleCreateScope() {
    const name = state.sidebar.newScopeName.trim();
    if (!name) return;
    const res = await api.createScope(state.fetcher, state.projectId, name);
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

  async function handleCreateWorkingCopy() {
    const name = state.sidebar.newWcName.trim();
    if (!state.sidebar.activeScope) {
      state.setError("Select a scope before creating a working copy");
      return;
    }
    if (!name) return;
    const scopeId = state.sidebar.activeScope;
    const res = await api.createWorkingCopy(state.fetcher, state.projectId, { name, scopeId });
    if (!res.ok) {
      state.setError("Failed to create working copy");
      return;
    }
    const parsed = await res.json().catch(() => null);
    if (!parsed) {
      state.setError("Failed to create working copy");
      return;
    }
    state.workingCopies = [
      ...state.workingCopies,
      { id: parsed.id, name, scopeId, path: parsed.path, pathKind: parsed.pathKind },
    ];
    state.sidebar.newWcName = "";
  }

  async function handleDeleteScope(scopeId: string) {
    const res = await api.deleteScope(state.fetcher, state.projectId, scopeId);
    if (!res.ok) {
      state.setError("Failed to delete scope");
      return;
    }
    state.scopes = state.scopes.filter((s) => s.id !== scopeId);
    state.scopeRels = state.scopeRels.filter((r) => r.scopeId !== scopeId);
    if (state.sidebar.activeScope === scopeId) state.sidebar.activeScope = null;
  }

  async function handleAddToScope(scopeId: string) {
    if (state.selection.selectedCards.size === 0) return;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.addCardsToScope(state.fetcher, state.projectId, scopeId, cardIds);
    if (!res.ok) {
      state.setError("Failed to add cards to scope");
      return;
    }
    const newRels = cardIds
      .filter((cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
      .map((cardId) => ({ scopeId, cardId }));
    state.scopeRels = [...state.scopeRels, ...newRels];
    state.selection.selectedCards = new Set();
  }

  async function handleRemoveFromScope(scopeId: string) {
    if (state.selection.selectedCards.size === 0) return;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.removeCardsFromScope(state.fetcher, state.projectId, scopeId, cardIds);
    if (!res.ok) {
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
    handleCreateScope,
    handleDeleteScope,
    handleAddToScope,
    handleRemoveFromScope,
    handleCreateWorkingCopy,
  };
}
