import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CardWithGlue, ScopeArea, Warp } from "$lib/types";
import {
  ClientError,
  type KozaneClient,
  type CardCreateResult,
} from "../../../../../client/src/backend/contract.js";
import { NamespaceState } from "../../../../../client/src/board/namespace-state.svelte.js";
import { createClientBoardPersistence } from "../../../../../client/src/board/lib/board-backend-persistence.js";

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
} satisfies Parameters<typeof createClientBoardPersistence>[1];
function card(id: string, overrides: Partial<CardWithGlue> = {}): CardWithGlue {
  return {
    id,
    partitionId: "p1",
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
function creationResult(value: CardWithGlue): CardCreateResult {
  return { ...value, taskspaceId: null, glueId: null, width: null, placements: [] };
}
const refused = new ClientError("validation", "Refused");
const succeeded = { ok: true as const, stacking: [] };
function state(): NamespaceState {
  const s = new NamespaceState();
  s.namespaceId = "ns-1";
  return s;
}
function persistence(s: NamespaceState) {
  return createClientBoardPersistence(s, backend);
}
beforeEach(() => vi.resetAllMocks());

describe("createClientBoardPersistence", () => {
  it("answers whether positions and widths were saved", async () => {
    const s = state();
    const persist = persistence(s);
    backend.cards.updatePositions.mockResolvedValueOnce({ ok: true });
    backend.cards.update.mockRejectedValueOnce(refused);
    await expect(persist.persistPositions([{ cardId: "c1", posX: 1, posY: 2 }])).resolves.toBe(
      true,
    );
    await expect(persist.persistWidth("c1", 300)).resolves.toBe(false);
    expect(backend.cards.updatePositions).toHaveBeenCalledWith("ns-1", {
      positions: [{ cardId: "c1", posX: 1, posY: 2 }],
    });
    expect(backend.cards.update).toHaveBeenCalledWith("ns-1", "c1", { width: 300 });
  });
  it("writes back the stored warp after a move", async () => {
    const s = state();
    s.warps = [{ id: "w1", namespaceId: "ns-1", posX: 0, posY: 0 }];
    const stored: Warp = { id: "w1", namespaceId: "ns-1", posX: 1000, posY: 800 };
    backend.warps.update.mockResolvedValueOnce(stored);
    await expect(persistence(s).persistWarpPosition("w1", { posX: 1005, posY: 801 })).resolves.toBe(
      true,
    );
    expect(s.warps).toEqual([stored]);
  });
  it("writes back only the frame that moved", async () => {
    const s = state();
    const frame = (id: string, posX: number): ScopeArea => ({
      id,
      scopeId: "s1",
      namespaceId: "ns-1",
      posX,
      posY: 0,
      width: 200,
      height: 200,
    });
    s.scopeAreas = [frame("a1", 0), frame("a2", 500)];
    backend.scopes.updateArea.mockResolvedValueOnce(frame("a2", 600));
    await persistence(s).persistScopeArea("s1", "a2", {
      posX: 600,
      posY: 0,
      width: 200,
      height: 200,
    });
    expect(s.scopeAreas.map((a) => a.posX)).toEqual([0, 600]);
  });
  it("does not touch the board when a frame save is refused", async () => {
    const s = state();
    const previous = s.scopeAreas;
    backend.scopes.updateArea.mockRejectedValueOnce(refused);
    await expect(
      persistence(s).persistScopeArea("s1", "a1", { posX: 0, posY: 0, width: 200, height: 200 }),
    ).resolves.toBe(false);
    expect(s.scopeAreas).toBe(previous);
    expect(s.mutations.idle).toBe(true);
  });
  describe("submitComposer", () => {
    it("saves an edit and closes the composer", async () => {
      const s = state();
      s.cards = [card("c1")];
      s.selection.composerCard = s.cards[0];
      backend.cards.update.mockResolvedValueOnce({ ...succeeded, content: "new text" });
      const placeNew = vi.fn();
      await persistence(s).submitComposer("c1", "new text", "p2", placeNew);
      expect(s.cards[0]).toMatchObject({ content: "new text", partitionId: "p2" });
      expect(s.selection.composerCard).toBeNull();
      expect(placeNew).not.toHaveBeenCalled();
    });
    it("falls back to trimmed text when a backend omits normalized content", async () => {
      const s = state();
      s.cards = [card("c1")];
      backend.cards.update.mockResolvedValueOnce(succeeded);
      await persistence(s).submitComposer("c1", "  new text \n", "p1", vi.fn());
      expect(s.cards[0].content).toBe("new text");
    });
    it("holds the text the backend says it stored", async () => {
      const s = state();
      s.cards = [card("c1")];
      backend.cards.update.mockResolvedValueOnce({ ...succeeded, content: "normalized" });
      await persistence(s).submitComposer("c1", "  typed  ", "p1", vi.fn());
      expect(s.cards[0].content).toBe("normalized");
    });
    it("draws every card a refit moved, a repaired neighbour included", async () => {
      const s = state();
      const stored = (slot: number) => ({ inventory: { id: "i1", slot } });
      s.cards = [card("c1", stored(0)), card("c2", stored(6)), card("c3", stored(2))];
      backend.cards.update.mockResolvedValueOnce({
        ...succeeded,
        content: "longer text",
        placements: [
          { cardId: "c2", inventoryId: "i1", slot: 1 },
          { cardId: "c1", inventoryId: "i1", slot: 3 },
        ],
      });
      const untouched = s.cards[2];
      await persistence(s).submitComposer("c1", "longer text", "p1", vi.fn());
      expect(s.cards.map((c) => c.inventory?.slot)).toEqual([3, 1, 2]);
      expect(s.cards[0].content).toBe("longer text");
      expect(s.cards[2]).toBe(untouched);
    });
    it("reports the backend reason and retains the composer when an edit is refused", async () => {
      const s = state();
      s.cards = [card("c1")];
      s.selection.composerCard = s.cards[0];
      backend.cards.update.mockRejectedValueOnce(new ClientError("validation", "Too long"));
      await persistence(s).submitComposer("c1", "x", "p1", () => ({ posX: 0, posY: 0 }));
      expect(s.lastError).toBe("Too long");
      expect(s.cards[0].content).toBe("c1");
      expect(s.selection.composerCard).toEqual(s.cards[0]);
      expect(s.mutations.idle).toBe(true);
    });
    it("creates a card in the active scope from the stored row, leaving stacking to the backend", async () => {
      const s = state();
      s.cards = [card("c1", { zIndex: 4 }), card("c2", { layerId: "l2", zIndex: 9 })];
      s.activeLayerId = "l1";
      s.sidebar.activeScope = "s1";
      const created = card("c3", { posX: 10, posY: 20, zIndex: 5 });
      backend.cards.create.mockResolvedValueOnce(creationResult(created));
      await persistence(s).submitComposer(null, "c3", "p1", () => ({ posX: 10, posY: 20 }));
      expect(backend.cards.create).toHaveBeenCalledWith("ns-1", {
        partitionId: "p1",
        content: "c3",
        posX: 10,
        posY: 20,
        scopeId: "s1",
        layerId: "l1",
      });
      expect(s.cards.at(-1)).toEqual(created);
      expect(s.scopeRels).toContainEqual({ scopeId: "s1", cardId: "c3" });
    });
    it("lists a created card once when a snapshot poll already brought it in", async () => {
      const s = state();
      s.sidebar.activeScope = "s1";
      const created = card("c3", { posX: 10, posY: 20, zIndex: 5 });
      backend.cards.create.mockImplementationOnce(async () => {
        await Promise.resolve();
        s.cards = [card("c1"), card("c3")];
        s.scopeRels = [{ scopeId: "s1", cardId: "c3" }];
        return creationResult(created);
      });
      await persistence(s).submitComposer(null, "c3", "p1", () => ({ posX: 10, posY: 20 }));
      expect(s.cards.map((c) => c.id)).toEqual(["c1", "c3"]);
      expect(s.cards.at(-1)).toEqual(created);
      expect(s.scopeRels).toEqual([{ scopeId: "s1", cardId: "c3" }]);
    });
    it("refuses a created card whose answer is not a row", async () => {
      const s = state();
      // @ts-expect-error Exercise a noncompliant custom backend's malformed result.
      backend.cards.create.mockResolvedValueOnce({});
      await persistence(s).submitComposer(null, "x", "p1", () => ({ posX: 0, posY: 0 }));
      expect(s.lastError).toBe("Failed to create card");
      expect(s.cards).toEqual([]);
    });
    it("holds mutation activity until the save and local reconciliation finish", async () => {
      const s = state();
      s.cards = [card("c1")];
      let finish!: (value: Awaited<ReturnType<KozaneClient["cards"]["update"]>>) => void;
      backend.cards.update.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const pending = persistence(s).submitComposer("c1", "saved", "p1", vi.fn());
      expect(s.mutations.idle).toBe(false);
      finish({ ...succeeded, content: "saved" });
      await pending;
      expect(s.cards[0].content).toBe("saved");
      expect(s.mutations.idle).toBe(true);
    });
  });
});
