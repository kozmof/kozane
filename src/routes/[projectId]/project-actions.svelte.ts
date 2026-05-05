import type { CardData, Bundle, Scope, ScopeRel, GlueRel, WorkingCopy } from "$lib/types";
import * as api from "./lib/project-api";

export type ProjectPageState = {
  projectId: string;
  fetcher: typeof fetch;

  get cards(): CardData[];
  set cards(value: CardData[]);

  get bundles(): Bundle[];
  set bundles(value: Bundle[]);

  get scopes(): Scope[];
  set scopes(value: Scope[]);

  get scopeRels(): ScopeRel[];
  set scopeRels(value: ScopeRel[]);

  get glueRels(): GlueRel[];
  set glueRels(value: GlueRel[]);

  get selectedCards(): Set<string>;
  set selectedCards(value: Set<string>);

  get primarySelectedId(): string | null;
  set primarySelectedId(value: string | null);

  get composerCard(): CardData | null;
  set composerCard(value: CardData | null);

  get activeBundle(): string | null;
  set activeBundle(value: string | null);

  get activeScope(): string | null;
  set activeScope(value: string | null);

  get newBundleName(): string;
  set newBundleName(value: string);

  get newScopeName(): string;
  set newScopeName(value: string);

  get newWcName(): string;
  set newWcName(value: string);

  get workingCopies(): WorkingCopy[];
  set workingCopies(value: WorkingCopy[]);

  setError(message: string): void;
};

export function createProjectActions(state: ProjectPageState) {
  async function handleCardBundleChange(newBundleId: string) {
    if (!state.composerCard) return;
    const cardId = state.composerCard.id;
    const res = await api.updateCard(state.fetcher, state.projectId, cardId, {
      bundleId: newBundleId,
    });
    if (!res.ok) {
      state.setError("Failed to change bundle");
      return;
    }
    state.cards = state.cards.map((c) => (c.id === cardId ? { ...c, bundleId: newBundleId } : c));
  }

  async function handleSelectionBundleChange(cardIds: string[], newBundleId: string) {
    const results = await Promise.all(
      cardIds.map((id) =>
        api.updateCard(state.fetcher, state.projectId, id, { bundleId: newBundleId }),
      ),
    );
    if (results.some((r) => !r.ok)) {
      state.setError("Failed to change bundle for selected cards");
      return;
    }
    state.cards = state.cards.map((c) =>
      cardIds.includes(c.id) ? { ...c, bundleId: newBundleId } : c,
    );
  }

  async function handleGlueSelected(cardIds: string[]) {
    const res = await api.glueCards(state.fetcher, state.projectId, cardIds);
    if (!res.ok) {
      state.setError("Failed to glue cards");
      return;
    }
    const { glueId } = await res.json();
    state.glueRels = [
      ...state.glueRels.filter((r) => !cardIds.includes(r.cardId)),
      ...cardIds.map((cardId) => ({ glueId, cardId })),
    ];
    state.cards = state.cards.map((c) => (cardIds.includes(c.id) ? { ...c, glueId } : c));
  }

  async function handleUnglueOne(cardId: string) {
    const res = await api.unglueCards(state.fetcher, state.projectId, [cardId]);
    if (!res.ok) {
      state.setError("Failed to unglue card");
      return;
    }
    state.glueRels = state.glueRels.filter((r) => r.cardId !== cardId);
    state.cards = state.cards.map((c) => (c.id === cardId ? { ...c, glueId: null } : c));
  }

  async function handleUnglueSelected(cardIds: string[]) {
    const res = await api.unglueCards(state.fetcher, state.projectId, cardIds);
    if (!res.ok) {
      state.setError("Failed to unglue cards");
      return;
    }
    state.glueRels = state.glueRels.filter((r) => !cardIds.includes(r.cardId));
    state.cards = state.cards.map((c) => (cardIds.includes(c.id) ? { ...c, glueId: null } : c));
  }

  async function handleDeleteSelected(cardIds: string[]) {
    const results = await Promise.all(
      cardIds.map((id) => api.deleteCard(state.fetcher, state.projectId, id)),
    );
    if (results.some((r) => !r.ok)) {
      state.setError("Failed to delete cards");
      return;
    }
    state.cards = state.cards.filter((c) => !cardIds.includes(c.id));
    state.glueRels = state.glueRels.filter((r) => !cardIds.includes(r.cardId));
    state.selectedCards = new Set();
    state.primarySelectedId = null;
  }

  async function handleCreateBundle() {
    const name = state.newBundleName.trim();
    if (!name) return;
    const res = await api.createBundle(state.fetcher, state.projectId, name);
    if (!res.ok) {
      state.setError("Failed to create bundle");
      return;
    }
    const { id } = await res.json();
    state.bundles = [...state.bundles, { id, projectId: state.projectId, name, isDefault: false }];
    state.newBundleName = "";
  }

  async function handleDeleteBundle(bundleId: string) {
    const res = await api.deleteBundle(state.fetcher, state.projectId, bundleId);
    if (!res.ok) {
      state.setError("Failed to delete bundle");
      return;
    }
    const { defaultBundleId } = await res.json();
    state.cards = state.cards.map((c) =>
      c.bundleId === bundleId ? { ...c, bundleId: defaultBundleId } : c,
    );
    state.bundles = state.bundles.filter((b) => b.id !== bundleId);
    if (state.activeBundle === bundleId) state.activeBundle = null;
  }

  async function handleCreateScope() {
    const name = state.newScopeName.trim();
    if (!name) return;
    const res = await api.createScope(state.fetcher, state.projectId, name);
    if (!res.ok) {
      state.setError("Failed to create scope");
      return;
    }
    const { id } = await res.json();
    state.scopes = [...state.scopes, { id, name }];
    state.newScopeName = "";
  }

  async function handleCreateWorkingCopy() {
    const name = state.newWcName.trim();
    if (!name || !state.activeScope) return;
    const scopeId = state.activeScope;
    const res = await api.createWorkingCopy(state.fetcher, state.projectId, { name, scopeId });
    if (!res.ok) {
      state.setError("Failed to create working copy");
      return;
    }
    const { id, path } = await res.json();
    state.workingCopies = [...state.workingCopies, { id, name, scopeId, path }];
    state.newWcName = "";
  }

  async function handleDeleteScope(scopeId: string) {
    const res = await api.deleteScope(state.fetcher, state.projectId, scopeId);
    if (!res.ok) {
      state.setError("Failed to delete scope");
      return;
    }
    state.scopes = state.scopes.filter((s) => s.id !== scopeId);
    state.scopeRels = state.scopeRels.filter((r) => r.scopeId !== scopeId);
    if (state.activeScope === scopeId) state.activeScope = null;
  }

  async function handleAddToScope(scopeId: string) {
    if (state.selectedCards.size === 0) return;
    const cardIds = [...state.selectedCards];
    const res = await api.addCardsToScope(state.fetcher, state.projectId, scopeId, cardIds);
    if (!res.ok) {
      state.setError("Failed to add cards to scope");
      return;
    }
    const newRels = cardIds
      .filter((cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
      .map((cardId) => ({ scopeId, cardId }));
    state.scopeRels = [...state.scopeRels, ...newRels];
    state.selectedCards = new Set();
  }

  async function handleRemoveFromScope(scopeId: string) {
    if (state.selectedCards.size === 0) return;
    const cardIds = [...state.selectedCards];
    const res = await api.removeCardsFromScope(state.fetcher, state.projectId, scopeId, cardIds);
    if (!res.ok) {
      state.setError("Failed to remove cards from scope");
      return;
    }
    state.scopeRels = state.scopeRels.filter(
      (r) => !(r.scopeId === scopeId && cardIds.includes(r.cardId)),
    );
    state.selectedCards = new Set();
  }

  return {
    handleCardBundleChange,
    handleSelectionBundleChange,
    handleGlueSelected,
    handleUnglueOne,
    handleUnglueSelected,
    handleDeleteSelected,
    handleCreateBundle,
    handleDeleteBundle,
    handleCreateScope,
    handleDeleteScope,
    handleAddToScope,
    handleRemoveFromScope,
    handleCreateWorkingCopy,
  };
}
