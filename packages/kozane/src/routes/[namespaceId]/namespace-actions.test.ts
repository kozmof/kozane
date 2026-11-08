import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNamespaceActions } from "../../../../client/src/board/namespace-actions.svelte.js";
import { NamespaceState } from "../../../../client/src/board/namespace-state.svelte.js";
import type { CardWithGlue } from "$lib/types";
import { ClientError, type KozaneClient } from "../../../../client/src/client/contract.js";

const backend = {
  cards: {
    create: vi.fn<KozaneClient["cards"]["create"]>(),
    update: vi.fn<KozaneClient["cards"]["update"]>(),
    updatePositions: vi.fn<KozaneClient["cards"]["updatePositions"]>(),
    remove: vi.fn<KozaneClient["cards"]["remove"]>(),
    removeOne: vi.fn<KozaneClient["cards"]["removeOne"]>(),
    move: vi.fn<KozaneClient["cards"]["move"]>(),
    setLayer: vi.fn<KozaneClient["cards"]["setLayer"]>(),
    setPartition: vi.fn<KozaneClient["cards"]["setPartition"]>(),
    setStacking: vi.fn<KozaneClient["cards"]["setStacking"]>(),
    squash: vi.fn<KozaneClient["cards"]["squash"]>(),
  },
  glues: {
    create: vi.fn<KozaneClient["glues"]["create"]>(),
    remove: vi.fn<KozaneClient["glues"]["remove"]>(),
  },
  layers: {
    create: vi.fn<KozaneClient["layers"]["create"]>(),
    rename: vi.fn<KozaneClient["layers"]["rename"]>(),
    remove: vi.fn<KozaneClient["layers"]["remove"]>(),
    reorder: vi.fn<KozaneClient["layers"]["reorder"]>(),
  },
  partitions: {
    create: vi.fn<KozaneClient["partitions"]["create"]>(),
    rename: vi.fn<KozaneClient["partitions"]["rename"]>(),
    remove: vi.fn<KozaneClient["partitions"]["remove"]>(),
  },
  warps: {
    create: vi.fn<KozaneClient["warps"]["create"]>(),
    update: vi.fn<KozaneClient["warps"]["update"]>(),
    remove: vi.fn<KozaneClient["warps"]["remove"]>(),
  },
  scopes: {
    create: vi.fn<KozaneClient["scopes"]["create"]>(),
    rename: vi.fn<KozaneClient["scopes"]["rename"]>(),
    remove: vi.fn<KozaneClient["scopes"]["remove"]>(),
    addMembers: vi.fn<KozaneClient["scopes"]["addMembers"]>(),
    removeMembers: vi.fn<KozaneClient["scopes"]["removeMembers"]>(),
    createArea: vi.fn<KozaneClient["scopes"]["createArea"]>(),
    updateArea: vi.fn<KozaneClient["scopes"]["updateArea"]>(),
    removeArea: vi.fn<KozaneClient["scopes"]["removeArea"]>(),
  },
  taskspaces: {
    access: vi.fn<NonNullable<KozaneClient["taskspaces"]>["access"]>(),
    create: vi.fn<NonNullable<KozaneClient["taskspaces"]>["create"]>(),
    rename: vi.fn<NonNullable<KozaneClient["taskspaces"]>["rename"]>(),
    remove: vi.fn<NonNullable<KozaneClient["taskspaces"]>["remove"]>(),
    createFile: vi.fn<NonNullable<KozaneClient["taskspaces"]>["createFile"]>(),
    readFile: vi.fn<NonNullable<KozaneClient["taskspaces"]>["readFile"]>(),
    saveFile: vi.fn<NonNullable<KozaneClient["taskspaces"]>["saveFile"]>(),
    list: vi.fn<NonNullable<KozaneClient["taskspaces"]>["list"]>(),
    createDirectory: vi.fn<NonNullable<KozaneClient["taskspaces"]>["createDirectory"]>(),
    renameEntry: vi.fn<NonNullable<KozaneClient["taskspaces"]>["renameEntry"]>(),
    removeEntry: vi.fn<NonNullable<KozaneClient["taskspaces"]>["removeEntry"]>(),
  },
} satisfies Parameters<typeof createNamespaceActions>[1];
function actionsFor(state: NamespaceState) {
  return createNamespaceActions(state, backend);
}

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
    inventory: null,
    width: null,
    ...overrides,
  };
}

const refused = new ClientError("validation", "Refused");
const succeeded = { ok: true as const, stacking: [] };

function stateWith(cards: CardWithGlue[]): NamespaceState {
  const state = new NamespaceState();
  state.namespaceId = "namespace-1";
  state.cards = cards;
  return state;
}

/** Controls deferred completion so a test can interleave two actions. */
function deferred<T>() {
  let settle!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  return { promise, settle, reject };
}

beforeEach(() => vi.resetAllMocks());

describe("optimistic rollback", () => {
  it("restores only the field it changed, on the card it changed", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    const actions = actionsFor(state);
    backend.cards.setPartition.mockRejectedValue(refused);

    await actions.handleSelectionPartitionChange(["card-1"], "b2");

    expect(state.cards.find((c) => c.id === "card-1")?.partitionId).toBe("b1");
    expect(state.cards.find((c) => c.id === "card-2")?.partitionId).toBe("b1");
  });

  // Rollback must preserve changes made while the failed request was in flight.
  it("leaves a change applied by another action in flight alone", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    const actions = actionsFor(state);

    const partitionCall = deferred<{ ok: true }>();
    backend.cards.setPartition.mockReturnValue(partitionCall.promise);
    backend.cards.setLayer.mockResolvedValue(succeeded);

    // Starts, and parks before its failure lands.
    const partitionChange = actions.handleSelectionPartitionChange(["card-1"], "b2");
    // A second edit, to a different card, succeeds in the meantime.
    await actions.handleSelectionLayerChange(["card-2"], "l2");
    partitionCall.reject(refused);
    await partitionChange;

    expect(state.cards.find((c) => c.id === "card-1")?.partitionId).toBe("b1");
    expect(state.cards.find((c) => c.id === "card-2")?.layerId).toBe("l2");
  });

  it("puts deleted cards and their glue back without dropping a concurrent edit", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.glueRels = [{ glueId: "g1", cardId: "card-1" }];
    const actions = actionsFor(state);

    const deleteCall = deferred<{ ok: true }>();
    backend.cards.remove.mockReturnValue(deleteCall.promise);
    backend.cards.setLayer.mockResolvedValue(succeeded);

    const deletion = actions.handleDeleteSelected(["card-1"]);
    expect(state.cards.map((c) => c.id)).toEqual(["card-2"]);

    await actions.handleSelectionLayerChange(["card-2"], "l2");
    deleteCall.reject(refused);
    await deletion;

    expect(state.cards.map((c) => c.id).sort()).toEqual(["card-1", "card-2"]);
    expect(state.glueRels).toEqual([{ glueId: "g1", cardId: "card-1" }]);
    // The concurrent edit survived the undo.
    expect(state.cards.find((c) => c.id === "card-2")?.layerId).toBe("l2");
  });

  it("does not resurrect a card the board regained while the delete was in flight", async () => {
    const state = stateWith([card("card-1")]);
    const actions = actionsFor(state);
    const deleteCall = deferred<{ ok: true }>();
    backend.cards.remove.mockReturnValue(deleteCall.promise);

    const deletion = actions.handleDeleteSelected(["card-1"]);
    // A snapshot poll landing between the removal and the failure brings it back.
    state.cards = [card("card-1", { content: "edited elsewhere" })];
    deleteCall.reject(refused);
    await deletion;

    expect(state.cards).toHaveLength(1);
    expect(state.cards[0].content).toBe("edited elsewhere");
  });

  it("keeps a primary selection made while the delete was in flight", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.selection.selectedCards = new Set(["card-1"]);
    state.selection.primarySelectedId = "card-1";
    const actions = actionsFor(state);
    const deleteCall = deferred<{ ok: true }>();
    backend.cards.remove.mockReturnValue(deleteCall.promise);

    const deletion = actions.handleDeleteSelected(["card-1"]);
    state.selection.primarySelectedId = "card-2";
    deleteCall.reject(refused);
    await deletion;

    expect(state.selection.primarySelectedId).toBe("card-2");
    expect(state.selection.selectedCards.has("card-1")).toBe(true);
  });
});

describe("handleLinkScope", () => {
  it("adds the selection to the scope and keeps it selected", async () => {
    const state = stateWith([card("card-1"), card("card-2")]);
    state.selection.selectedCards = new Set(["card-1", "card-2"]);
    const actions = actionsFor(state);
    backend.scopes.addMembers.mockResolvedValue({ ok: true });

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
    const actions = actionsFor(state);
    backend.scopes.addMembers.mockResolvedValue({ ok: true });

    await actions.handleLinkScope("s1");

    expect(state.scopeRels).toEqual([
      { scopeId: "s1", cardId: "card-1" },
      { scopeId: "s1", cardId: "card-2" },
    ]);
  });

  it("reports the server's own wording and links nothing", async () => {
    const state = stateWith([card("card-1")]);
    state.selection.selectedCards = new Set(["card-1"]);
    const actions = actionsFor(state);
    backend.scopes.addMembers.mockRejectedValue(refused);
    backend.scopes.addMembers.mockRejectedValue(new ClientError("validation", "Scope not found"));

    expect(await actions.handleLinkScope("s1")).toBe(false);
    expect(state.lastError).toBe("Scope not found");
    expect(state.scopeRels).toEqual([]);
  });

  it("does nothing with an empty selection", async () => {
    const actions = actionsFor(stateWith([]));
    expect(await actions.handleLinkScope("s1")).toBe(false);
    expect(backend.scopes.addMembers).not.toHaveBeenCalled();
  });
});

describe("createTaskspace", () => {
  it("adds the new taskspace to the scope it was made in", async () => {
    const state = stateWith([]);
    const actions = actionsFor(state);
    backend.taskspaces.create.mockResolvedValue({
      id: "t1",
      path: "notes",
      pathKind: "workspace_relative",
    });

    expect(await actions.createTaskspace("s1", "  notes ")).toEqual({ id: "t1" });
    expect(backend.taskspaces.create).toHaveBeenCalledWith("namespace-1", {
      name: "notes",
      scopeId: "s1",
    });
    expect(state.taskspaces).toEqual([
      { id: "t1", name: "notes", scopeId: "s1", path: "notes", pathKind: "workspace_relative" },
    ]);
  });

  it("returns the server's reason instead of raising the banner", async () => {
    const state = stateWith([]);
    const actions = actionsFor(state);
    backend.taskspaces.create.mockRejectedValue(refused);
    backend.taskspaces.create.mockRejectedValue(
      new ClientError("conflict", "Taskspace directory already exists"),
    );

    expect(await actions.createTaskspace("s1", "notes")).toEqual({
      error: "Taskspace directory already exists",
    });
    expect(state.lastError).toBeNull();
    expect(state.taskspaces).toEqual([]);
  });

  it("refuses a blank name without asking the server", async () => {
    const actions = actionsFor(stateWith([]));
    expect(await actions.createTaskspace("s1", "  ")).toEqual({
      error: "Taskspace name is required",
    });
    expect(backend.taskspaces.create).not.toHaveBeenCalled();
  });
});

describe("handleCreateScopeWithFile", () => {
  const names = { scope: "work", taskspace: "notes", file: "plan.md" };

  function succeedingState() {
    const state = stateWith([card("card-1")]);
    state.selection.selectedCards = new Set(["card-1"]);
    backend.scopes.create.mockResolvedValue({ id: "s1" });
    backend.taskspaces.create.mockResolvedValue({
      id: "t1",
      path: "notes",
      pathKind: "workspace_relative",
    });
    backend.taskspaces.createFile.mockResolvedValue({
      path: "plan.md",
      content: "",
      signature: "signature",
    });
    backend.scopes.addMembers.mockResolvedValue({ ok: true });
    return state;
  }

  it("creates the scope, taskspace and file, links the cards, and says what to open", async () => {
    const state = succeedingState();
    const actions = actionsFor(state);

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
    const actions = actionsFor(state);
    const order: string[] = [];
    backend.taskspaces.createFile.mockImplementation(async () => {
      order.push("file");
      return { path: "plan.md", content: "", signature: "signature" };
    });
    backend.scopes.addMembers.mockImplementation(async () => {
      order.push("link");
      return { ok: true };
    });

    await actions.handleCreateScopeWithFile(names);
    expect(order).toEqual(["file", "link"]);
  });

  it("surfaces why a scope name was refused rather than a fixed message", async () => {
    const state = stateWith([card("card-1")]);
    const actions = actionsFor(state);
    backend.scopes.create.mockRejectedValue(refused);
    backend.scopes.create.mockRejectedValue(
      new ClientError("conflict", 'A scope named "work" already exists'),
    );

    expect(await actions.handleCreateScopeWithFile(names)).toBeNull();
    expect(state.lastError).toBe('A scope named "work" already exists');
    expect(state.scopes).toEqual([]);
    expect(backend.taskspaces.create).not.toHaveBeenCalled();
  });

  it("takes the new scope back down when the taskspace cannot be made", async () => {
    const state = stateWith([card("card-1")]);
    state.selection.selectedCards = new Set(["card-1"]);
    const actions = actionsFor(state);
    backend.scopes.create.mockResolvedValue({ id: "s1" });
    backend.taskspaces.create.mockRejectedValue(refused);
    backend.scopes.remove.mockResolvedValue({ ok: true });
    backend.taskspaces.create.mockRejectedValue(
      new ClientError("conflict", "Taskspace directory already exists"),
    );

    expect(await actions.handleCreateScopeWithFile(names)).toBeNull();

    expect(backend.scopes.remove).toHaveBeenCalledWith("namespace-1", "s1");
    expect(state.scopes).toEqual([]);
    expect(state.lastError).toBe("Taskspace directory already exists");
    expect(backend.taskspaces.createFile).not.toHaveBeenCalled();
  });

  it("retains the new scope when failed taskspace creation cannot be cleaned up", async () => {
    const state = stateWith([card("card-1")]);
    backend.scopes.create.mockResolvedValue({ id: "s1" });
    backend.taskspaces.create.mockRejectedValue(
      new ClientError("conflict", "Taskspace directory already exists"),
    );
    backend.scopes.remove.mockRejectedValue(new ClientError("unavailable", "Cleanup failed"));
    expect(await actionsFor(state).handleCreateScopeWithFile(names)).toBeNull();
    expect(state.scopes).toEqual([{ id: "s1", name: "work" }]);
    expect(state.taskspaces).toEqual([]);
    expect(state.lastError).toBe("Taskspace directory already exists");
    expect(state.mutations.idle).toBe(true);
  });

  it("keeps the scope and taskspace when only the file fails", async () => {
    const state = succeedingState();
    const actions = actionsFor(state);
    backend.taskspaces.createFile.mockRejectedValue(refused);
    backend.taskspaces.createFile.mockRejectedValue(
      new ClientError("conflict", "File already exists"),
    );

    expect(await actions.handleCreateScopeWithFile(names)).toBeNull();

    expect(state.lastError).toBe("File already exists");
    expect(state.scopes).toHaveLength(1);
    expect(state.taskspaces).toHaveLength(1);
    expect(backend.scopes.remove).not.toHaveBeenCalled();
  });

  it("still opens the file when only the link fails", async () => {
    const state = succeedingState();
    const actions = actionsFor(state);
    backend.scopes.addMembers.mockRejectedValue(refused);
    backend.scopes.addMembers.mockRejectedValue(new ClientError("validation", "Scope not found"));

    expect(await actions.handleCreateScopeWithFile(names)).not.toBeNull();
    expect(state.lastError).toBe("Scope not found");
  });

  it("refuses a blank name without asking the server", async () => {
    const actions = actionsFor(stateWith([]));

    expect(await actions.handleCreateScopeWithFile({ ...names, file: "  " })).toBeNull();
    expect(backend.scopes.create).not.toHaveBeenCalled();
  });

  it("trims the names it sends", async () => {
    const state = succeedingState();
    const actions = actionsFor(state);

    await actions.handleCreateScopeWithFile({
      scope: " work ",
      taskspace: " notes ",
      file: " plan.md ",
    });

    expect(backend.scopes.create).toHaveBeenCalledWith("namespace-1", { name: "work" });
    expect(backend.taskspaces.create).toHaveBeenCalledWith("namespace-1", {
      name: "notes",
      scopeId: "s1",
    });
    expect(backend.taskspaces.createFile).toHaveBeenCalledWith("namespace-1", "t1", {
      path: "plan.md",
    });
  });
});
