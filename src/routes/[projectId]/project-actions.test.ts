import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProjectActions } from "./project-actions.svelte.js";
import { ProjectState } from "./project-state.svelte.js";
import type { CardWithGlue } from "$lib/types";

vi.mock("./lib/project-api", () => ({
  updateCard: vi.fn(),
  deleteCards: vi.fn(),
  batchReassignBundle: vi.fn(),
  batchReassignLayer: vi.fn(),
  moveCardsToProject: vi.fn(),
  glueCards: vi.fn(),
  unglueCards: vi.fn(),
  squashCard: vi.fn(),
  failureMessage: vi.fn(),
  createBundle: vi.fn(),
  deleteBundle: vi.fn(),
  createLayer: vi.fn(),
  deleteLayer: vi.fn(),
  renameLayer: vi.fn(),
  reorderLayers: vi.fn(),
  createWarp: vi.fn(),
  deleteWarp: vi.fn(),
  parseWarp: vi.fn(),
  createScope: vi.fn(),
  deleteScope: vi.fn(),
  addCardsToScope: vi.fn(),
  removeCardsFromScope: vi.fn(),
  createTaskspace: vi.fn(),
}));

import * as api from "./lib/project-api";

function card(id: string, overrides: Partial<CardWithGlue> = {}): CardWithGlue {
  return {
    id,
    bundleId: "b1",
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

/** A response whose `ok` the action branches on; nothing here reads a body. */
const failed = { ok: false } as Response;
const succeeded = { ok: true, json: async () => ({}) } as unknown as Response;

function stateWith(cards: CardWithGlue[]): ProjectState {
  const state = new ProjectState();
  state.projectId = "project-1";
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
    const actions = createProjectActions(state);
    vi.mocked(api.batchReassignBundle).mockResolvedValue(failed);

    await actions.handleSelectionBundleChange(["card-1"], "b2");

    expect(state.cards.find((c) => c.id === "card-1")?.bundleId).toBe("b1");
    expect(state.cards.find((c) => c.id === "card-2")?.bundleId).toBe("b1");
  });

  // The regression this file exists for: the rollback used to put back the whole `cards`
  // array as it stood before the request, which also undid anything applied while it was
  // in flight.
  it("leaves a change applied by another action in flight alone", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    const actions = createProjectActions(state);

    const bundleCall = deferred<Response>();
    vi.mocked(api.batchReassignBundle).mockReturnValue(bundleCall.promise);
    vi.mocked(api.batchReassignLayer).mockResolvedValue(succeeded);

    // Starts, and parks before its failure lands.
    const bundleChange = actions.handleSelectionBundleChange(["card-1"], "b2");
    // A second edit, to a different card, succeeds in the meantime.
    await actions.handleSelectionLayerChange(["card-2"], "l2");
    bundleCall.settle(failed);
    await bundleChange;

    expect(state.cards.find((c) => c.id === "card-1")?.bundleId).toBe("b1");
    expect(state.cards.find((c) => c.id === "card-2")?.layerId).toBe("l2");
  });

  it("puts deleted cards and their glue back without dropping a concurrent edit", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.glueRels = [{ glueId: "g1", cardId: "card-1" }];
    const actions = createProjectActions(state);

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
    const actions = createProjectActions(state);
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
    const actions = createProjectActions(state);
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
