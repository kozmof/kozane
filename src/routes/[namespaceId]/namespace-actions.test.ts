import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNamespaceActions } from "./namespace-actions.svelte.js";
import { NamespaceState } from "./namespace-state.svelte.js";
import type { CardWithGlue } from "$lib/types";

vi.mock("./lib/namespace-api", () => ({
  updateCard: vi.fn(),
  deleteCards: vi.fn(),
  batchReassignPartition: vi.fn(),
  batchReassignLayer: vi.fn(),
  moveCardsToNamespace: vi.fn(),
  glueCards: vi.fn(),
  unglueCards: vi.fn(),
  squashCard: vi.fn(),
  failureMessage: vi.fn(),
  createPartition: vi.fn(),
  deletePartition: vi.fn(),
  createLayer: vi.fn(),
  deleteLayer: vi.fn(),
  renameLayer: vi.fn(),
  reorderLayers: vi.fn(),
  createWarp: vi.fn(),
  deleteWarp: vi.fn(),
  parseWarp: vi.fn(),
  parseCards: vi.fn(),
  createScope: vi.fn(),
  deleteScope: vi.fn(),
  addCardsToScope: vi.fn(),
  removeCardsFromScope: vi.fn(),
  createTaskspace: vi.fn(),
  createTaskspaceFile: vi.fn(),
}));

import * as api from "./lib/namespace-api.js";

function card(id: string, overrides: Partial<CardWithGlue> = {}): CardWithGlue {
  return {
    id,
    partitionId: "b1",
    layerId: "l1",
    content: id,
    posX: 0,
    posY: 0,
    zIndex: 0,
    glueId: null,
    taskspaceId: null,
    width: null,
    ...overrides,
  };
}

/** Response fixture used only for its `ok` status. */
const failed = { ok: false } as Response;
const succeeded = { ok: true, json: async () => ({}) } as unknown as Response;

function stateWith(cards: CardWithGlue[]): NamespaceState {
  const state = new NamespaceState();
  state.namespaceId = "namespace-1";
  state.cards = cards;
  return state;
}

/** Resolves the promise the mock returned, so a test can interleave two actions. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

beforeEach(() => vi.clearAllMocks());

describe("optimistic rollback", () => {
  it("restores only the field it changed, on the card it changed", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    const actions = createNamespaceActions(state);
    vi.mocked(api.batchReassignPartition).mockResolvedValue(failed);

    await actions.handleSelectionPartitionChange(["card-1"], "b2");

    expect(state.cards.find((c) => c.id === "card-1")?.partitionId).toBe("b1");
    expect(state.cards.find((c) => c.id === "card-2")?.partitionId).toBe("b1");
  });

  // Rollback must preserve changes made while the failed request was in flight.
  it("leaves a change applied by another action in flight alone", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    const actions = createNamespaceActions(state);

    const partitionCall = deferred<Response>();
    vi.mocked(api.batchReassignPartition).mockReturnValue(partitionCall.promise);
    vi.mocked(api.batchReassignLayer).mockResolvedValue(succeeded);

    // Starts, and parks before its failure lands.
    const partitionChange = actions.handleSelectionPartitionChange(["card-1"], "b2");
    // A second edit, to a different card, succeeds in the meantime.
    await actions.handleSelectionLayerChange(["card-2"], "l2");
    partitionCall.settle(failed);
    await partitionChange;

    expect(state.cards.find((c) => c.id === "card-1")?.partitionId).toBe("b1");
    expect(state.cards.find((c) => c.id === "card-2")?.layerId).toBe("l2");
  });

  it("puts deleted cards and their glue back without dropping a concurrent edit", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.glueRels = [{ glueId: "g1", cardId: "card-1" }];
    const actions = createNamespaceActions(state);

    const deleteCall = deferred<Response>();
    vi.mocked(api.deleteCards).mockReturnValue(deleteCall.promise);
    vi.mocked(api.batchReassignLayer).mockResolvedValue(succeeded);

    const deletion = actions.handleDeleteSelected(["card-1"]);
    expect(state.cards.map((c) => c.id)).toEqual(["card-2"]);

    await actions.handleSelectionLayerChange(["card-2"], "l2");
    deleteCall.settle(failed);
    await deletion;

    expect(state.cards.map((c) => c.id).sort()).toEqual(["card-1", "card-2"]);
    expect(state.glueRels).toEqual([{ glueId: "g1", cardId: "card-1" }]);
    // The concurrent edit survived the undo.
    expect(state.cards.find((c) => c.id === "card-2")?.layerId).toBe("l2");
  });

  it("does not resurrect a card the board regained while the delete was in flight", async () => {
    const state = stateWith([card("card-1")]);
    const actions = createNamespaceActions(state);
    const deleteCall = deferred<Response>();
    vi.mocked(api.deleteCards).mockReturnValue(deleteCall.promise);

    const deletion = actions.handleDeleteSelected(["card-1"]);
    // A snapshot poll landing between the removal and the failure brings it back.
    state.cards = [card("card-1", { content: "edited elsewhere" })];
    deleteCall.settle(failed);
    await deletion;

    expect(state.cards).toHaveLength(1);
    expect(state.cards[0].content).toBe("edited elsewhere");
  });

  it("keeps a primary selection made while the delete was in flight", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.selection.selectedCards = new Set(["card-1"]);
    state.selection.primarySelectedId = "card-1";
    const actions = createNamespaceActions(state);
    const deleteCall = deferred<Response>();
    vi.mocked(api.deleteCards).mockReturnValue(deleteCall.promise);

    const deletion = actions.handleDeleteSelected(["card-1"]);
    state.selection.primarySelectedId = "card-2";
    deleteCall.settle(failed);
    await deletion;

    expect(state.selection.primarySelectedId).toBe("card-2");
    expect(state.selection.selectedCards.has("card-1")).toBe(true);
  });
});

/** A response carrying a body, for the actions that read one. */
function answered(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("handleLinkScope", () => {
  it("adds the selection to the scope and keeps it selected", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.selection.selectedCards = new Set(["card-1", "card-2"]);
    const actions = createNamespaceActions(state);
    vi.mocked(api.addCardsToScope).mockResolvedValue(answered({ ok: true }));

    expect(await actions.handleLinkScope("s1")).toBe(true);

    expect(state.scopeRels).toEqual([
      { scopeId: "s1", cardId: "card-1" },
      { scopeId: "s1", cardId: "card-2" },
    ]);
    // Linking from the palette must preserve the selection it is acting on.
    expect(state.selection.selectedCards).toEqual(new Set(["card-1", "card-2"]));
  });

  it("does not duplicate a card already in the scope", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.selection.selectedCards = new Set(["card-1", "card-2"]);
    state.scopeRels = [{ scopeId: "s1", cardId: "card-1" }];
    const actions = createNamespaceActions(state);
    vi.mocked(api.addCardsToScope).mockResolvedValue(answered({ ok: true }));

    await actions.handleLinkScope("s1");

    expect(state.scopeRels).toEqual([
      { scopeId: "s1", cardId: "card-1" },
      { scopeId: "s1", cardId: "card-2" },
    ]);
  });

  it("reports the server's own wording and links nothing", async () => {
    const state = stateWith([card("card-1")]);
    state.selection.selectedCards = new Set(["card-1"]);
    const actions = createNamespaceActions(state);
    vi.mocked(api.addCardsToScope).mockResolvedValue(failed);
    vi.mocked(api.failureMessage).mockResolvedValue("Scope not found");

    expect(await actions.handleLinkScope("s1")).toBe(false);
    expect(state.lastError).toBe("Scope not found");
    expect(state.scopeRels).toEqual([]);
  });

  it("does nothing with an empty selection", async () => {
    const actions = createNamespaceActions(stateWith([]));
    expect(await actions.handleLinkScope("s1")).toBe(false);
    expect(api.addCardsToScope).not.toHaveBeenCalled();
  });
});

describe("handleCreateScopeWithFile", () => {
  const names = { scope: "work", taskspace: "notes", file: "plan.md" };

  function succeedingState() {
    const state = stateWith([card("card-1")]);
    state.selection.selectedCards = new Set(["card-1"]);
    vi.mocked(api.createScope).mockResolvedValue(answered({ id: "s1" }));
    vi.mocked(api.createTaskspace).mockResolvedValue(
      answered({ id: "t1", path: "notes", pathKind: "workspace_relative" }),
    );
    vi.mocked(api.createTaskspaceFile).mockResolvedValue(answered({ path: "plan.md" }));
    vi.mocked(api.addCardsToScope).mockResolvedValue(answered({ ok: true }));
    return state;
  }

  it("creates the scope, taskspace and file, links the cards, and says what to open", async () => {
    const state = succeedingState();
    const actions = createNamespaceActions(state);

    expect(await actions.handleCreateScopeWithFile(names)).toEqual({
      taskspaceId: "t1",
      taskspaceName: "notes",
      path: "plan.md",
    });

    expect(state.scopes).toEqual([{ id: "s1", name: "work" }]);
    expect(state.taskspaces).toEqual([
      { id: "t1", name: "notes", scopeId: "s1", path: "notes", pathKind: "workspace_relative" },
    ]);
    expect(state.scopeRels).toEqual([{ scopeId: "s1", cardId: "card-1" }]);
    expect(state.selection.selectedCards).toEqual(new Set(["card-1"]));
  });

  it("links the cards last, after the file is there", async () => {
    const state = succeedingState();
    const actions = createNamespaceActions(state);
    const order: string[] = [];
    vi.mocked(api.createTaskspaceFile).mockImplementation(async () => {
      order.push("file");
      return answered({ path: "plan.md" });
    });
    vi.mocked(api.addCardsToScope).mockImplementation(async () => {
      order.push("link");
      return answered({ ok: true });
    });

    await actions.handleCreateScopeWithFile(names);
    expect(order).toEqual(["file", "link"]);
  });

  it("surfaces why a scope name was refused rather than a fixed message", async () => {
    const state = stateWith([card("card-1")]);
    const actions = createNamespaceActions(state);
    vi.mocked(api.createScope).mockResolvedValue(failed);
    vi.mocked(api.failureMessage).mockResolvedValue('A scope named "work" already exists');

    expect(await actions.handleCreateScopeWithFile(names)).toBeNull();
    expect(state.lastError).toBe('A scope named "work" already exists');
    expect(state.scopes).toEqual([]);
    expect(api.createTaskspace).not.toHaveBeenCalled();
  });

  it("takes the new scope back down when the taskspace cannot be made", async () => {
    const state = stateWith([card("card-1")]);
    state.selection.selectedCards = new Set(["card-1"]);
    const actions = createNamespaceActions(state);
    vi.mocked(api.createScope).mockResolvedValue(answered({ id: "s1" }));
    vi.mocked(api.createTaskspace).mockResolvedValue(failed);
    vi.mocked(api.deleteScope).mockResolvedValue(answered({ ok: true }));
    vi.mocked(api.failureMessage).mockResolvedValue("Taskspace directory already exists");

    expect(await actions.handleCreateScopeWithFile(names)).toBeNull();

    expect(api.deleteScope).toHaveBeenCalledWith(expect.anything(), "namespace-1", "s1");
    expect(state.scopes).toEqual([]);
    expect(state.lastError).toBe("Taskspace directory already exists");
    expect(api.createTaskspaceFile).not.toHaveBeenCalled();
  });

  it("keeps the scope and taskspace when only the file fails", async () => {
    const state = succeedingState();
    const actions = createNamespaceActions(state);
    vi.mocked(api.createTaskspaceFile).mockResolvedValue(failed);
    vi.mocked(api.failureMessage).mockResolvedValue("File already exists");

    expect(await actions.handleCreateScopeWithFile(names)).toBeNull();

    expect(state.lastError).toBe("File already exists");
    expect(state.scopes).toHaveLength(1);
    expect(state.taskspaces).toHaveLength(1);
    expect(api.deleteScope).not.toHaveBeenCalled();
  });

  it("still opens the file when only the link fails", async () => {
    const state = succeedingState();
    const actions = createNamespaceActions(state);
    vi.mocked(api.addCardsToScope).mockResolvedValue(failed);
    vi.mocked(api.failureMessage).mockResolvedValue("Scope not found");

    expect(await actions.handleCreateScopeWithFile(names)).not.toBeNull();
    expect(state.lastError).toBe("Scope not found");
  });

  it("refuses a blank name without asking the server", async () => {
    const actions = createNamespaceActions(stateWith([]));

    expect(await actions.handleCreateScopeWithFile({ ...names, file: "  " })).toBeNull();
    expect(api.createScope).not.toHaveBeenCalled();
  });

  it("trims the names it sends", async () => {
    const state = succeedingState();
    const actions = createNamespaceActions(state);

    await actions.handleCreateScopeWithFile({
      scope: " work ",
      taskspace: " notes ",
      file: " plan.md ",
    });

    expect(api.createScope).toHaveBeenCalledWith(expect.anything(), "namespace-1", "work");
    expect(api.createTaskspace).toHaveBeenCalledWith(expect.anything(), "namespace-1", {
      name: "notes",
      scopeId: "s1",
    });
    expect(api.createTaskspaceFile).toHaveBeenCalledWith(
      expect.anything(),
      "namespace-1",
      "t1",
      "plan.md",
    );
  });
});
