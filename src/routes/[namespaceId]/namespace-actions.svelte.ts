import * as api from "./lib/namespace-api.js";
import type { CardWithGlue, GlueRel } from "$lib/types";
import type { NamespaceState } from "./namespace-state.svelte.js";
import type { BoardRect } from "$lib/constants";
import { readArray, readFiniteNumber, readString, readStringArray } from "./lib/response.js";

/**
 * Undoing an optimistic edit, by field and by card rather than by restoring the array the
 * edit started from.
 *
 * The whole-array form was wrong whenever two edits overlapped. Each one captured
 * `state.cards` before its request and put that copy back on failure, so a rollback also
 * reverted every change applied in the meantime — a card moved to another partition would
 * silently jump back because an unrelated delete failed. The poll is held off while a
 * mutation is pending (`NamespaceState.mutationFetcher`), but nothing serializes the user's
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

  // Glue/unglue and scope membership apply their changes only after the server
  // confirms them, so a failure needs no rollback — nothing was changed locally.
  async function handleGlueSelected(cardIds: string[]) {
    const res = await api.glueCards(state.mutationFetcher, state.namespaceId, cardIds);
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
   * Takes cards off the board before the server has confirmed they are gone, and hands
   * back the undo for it. Delete and move-to-namespace do exactly the same thing here and
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
    const res = await api.deleteCards(state.mutationFetcher, state.namespaceId, cardIds);
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
    const res = await api.squashCard(state.mutationFetcher, state.namespaceId, cardId);
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
    const res = await api.createWarp(state.mutationFetcher, state.namespaceId, position);
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
    // Moving cards is how you follow them: the layer they landed on becomes the one in front.
    state.activeLayerId = layerId;
  }

  /**
   * `cardIds` is one card for a plain selection, or a whole glue group when the selected
   * card is glued — the composer sends whichever the selection actually is. A group is not
   * guaranteed to share a layer (nothing enforces that), so the server restacks each layer
   * it finds them on separately and reports where every card landed, the same `stacking`
   * shape a layer move answers with.
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
    const scopeId = state.sidebar.activeScope;
    const res = await api.createTaskspace(state.mutationFetcher, state.namespaceId, {
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
   * Adds the selected cards to `scopeId` and leaves them selected.
   *
   * The difference from {@link handleAddToScope} is the whole reason this exists: that one
   * clears the selection when it succeeds, which is right for the sidebar — the button is
   * the end of what you were doing — and wrong for the file palette, where the selection is
   * the subject of the panel and every row is about it. Linking from there and watching the
   * panel empty itself would be the panel undoing its own premise.
   *
   * Answers whether the link took, so the palette can report it without a second source of
   * truth about what happened.
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
   * The whole of the palette's second flow: a scope, a taskspace inside it, one empty file
   * inside that, and the selected cards linked to the scope — in that order, over four
   * endpoints that already exist.
   *
   * Ordered so that the step most likely to fail comes before anything is linked. Both
   * early steps refuse for reasons worth reading — a scope name is unique across the whole
   * workspace, and a taskspace claims a directory named after it — so every failure here
   * carries the server's own wording rather than the fixed strings the older scope and
   * taskspace handlers use, which would turn "a scope named X already exists" into "Failed
   * to create scope" and leave the reader to guess.
   *
   * A taskspace that cannot be made takes its scope down with it. The scope was created a
   * moment ago for this taskspace alone, and leaving an empty one behind would be litter
   * from a flow that visibly did not finish. Past that point nothing is undone: a scope and
   * a taskspace are useful on their own, and the tree's own controls finish the job.
   *
   * Answers what to open, or null when there is nothing to open.
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
    if (!scope?.id) {
      state.setError(await api.failureMessage(scopeRes, "Failed to create scope"));
      return null;
    }
    const scopeId = scope.id as string;
    state.scopes = [...state.scopes, { id: scopeId, name: scopeName }];

    const taskspaceRes = await api.createTaskspace(state.mutationFetcher, state.namespaceId, {
      name: taskspaceName,
      scopeId,
    });
    const taskspace = taskspaceRes.ok ? await taskspaceRes.json().catch(() => null) : null;
    if (!taskspace?.id) {
      const message = await api.failureMessage(taskspaceRes, "Failed to create taskspace");
      // Undone rather than left behind: this scope was made for this taskspace, a moment
      // ago, and has nothing else in it. A rollback that itself fails is not worth a second
      // message — the scope is in the sidebar, where it can be deleted.
      await api.deleteScope(state.mutationFetcher, state.namespaceId, scopeId);
      state.scopes = state.scopes.filter((existing) => existing.id !== scopeId);
      state.setError(message);
      return null;
    }
    const taskspaceId = taskspace.id as string;
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

    // Last, so that nothing above has to unpick a membership to roll back. A link that
    // fails is reported and left there: the file exists and is worth opening regardless.
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
    state.scopeRels = state.scopeRels.filter(
      (r) => !(r.scopeId === scopeId && cardIds.includes(r.cardId)),
    );
    state.selection.selectedCards = new Set();
  }

  /**
   * Files the cards that crossed a frame's edge into the scope, or out of it.
   *
   * Optimistic, like every other mutation here, but rolled back only as far as it got: the
   * two calls are independent — a card coming in and another going out have nothing to do
   * with each other — so a failure in one leaves the other standing rather than undoing a
   * write the server accepted. The local relations are put back for whichever half failed,
   * and the next poll settles any disagreement.
   *
   * The selection is deliberately untouched: this runs at the end of a drag, and clearing it
   * would take away what the user is holding.
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
   * Puts a frame on the board for `scopeId`, at `rect`.
   *
   * Whatever the frame lands on joins the scope, which is the point of placing one around a
   * selection: the cards are already there, and the frame is how they are now held. The
   * caller works out the rectangle — it is the one that knows where the view is and what is
   * selected — and hands the members it covers along with it.
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
    // Appended, not replacing the scope's other frames: a scope may be framed in several
    // places, and drawing another one says so rather than moving the one already there.
    state.scopeAreas = [...state.scopeAreas, stored];
    if (covers.length > 0) {
      await handleScopeMembershipChange(scopeId, { entered: covers, exited: [] });
    }
  }

  /**
   * Names a new scope and frames it in one go, for a rectangle drawn on a board with nothing
   * yet to put in it — which is how a scope tends to start.
   *
   * The scope is created first and kept even if the frame fails: a named scope is a thing the
   * user asked for and can frame again, while unwinding it would throw the name away over a
   * failed rectangle.
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

  /**
   * Takes the frame off the board. The scope keeps every card in it: a frame says where a
   * scope is drawn, not what belongs to it, and removing one by accident must not be a way
   * to lose a membership list.
   */
  async function handleDeleteScopeArea(scopeId: string, areaId: string) {
    const prev = state.scopeAreas;
    // By id: the frame removed is the one whose button was clicked, not every frame the
    // scope happens to have here.
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
    handleLinkScope,
    handleCreateScopeWithFile,
    handleScopeMembershipChange,
    handleCreateScopeArea,
    handleCreateScopeWithArea,
    handleDeleteScopeArea,
  };
}
