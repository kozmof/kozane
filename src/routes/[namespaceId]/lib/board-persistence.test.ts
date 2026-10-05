import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CardWithGlue, ScopeArea, Warp } from "$lib/types";
import { NamespaceState } from "../namespace-state.svelte.js";
import { createBoardPersistence } from "./board-persistence.js";

vi.mock("./namespace-api", () => ({
  createCard: vi.fn(),
  updateCard: vi.fn(),
  patchCardPositions: vi.fn(),
  moveWarp: vi.fn(),
  moveScopeArea: vi.fn(),
  parseCard: vi.fn(),
  parseWarp: vi.fn(),
  parseScopeArea: vi.fn(),
  failureMessage: vi.fn(),
}));

import * as api from "./namespace-api.js";

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
    width: null,
    ...overrides,
  };
}

const failed = { ok: false } as Response;
const succeeded = { ok: true, json: async () => ({}) } as unknown as Response;

function state(): NamespaceState {
  const s = new NamespaceState();
  s.namespaceId = "ns-1";
  return s;
}

beforeEach(() => vi.clearAllMocks());

describe("createBoardPersistence", () => {
  it("answers whether positions and widths were saved", async () => {
    const s = state();
    const persist = createBoardPersistence(s);
    vi.mocked(api.patchCardPositions).mockResolvedValueOnce(succeeded);
    vi.mocked(api.updateCard).mockResolvedValueOnce(failed);

    await expect(persist.persistPositions([{ cardId: "c1", posX: 1, posY: 2 }])).resolves.toBe(
      true,
    );
    await expect(persist.persistWidth("c1", 300)).resolves.toBe(false);
    expect(api.patchCardPositions).toHaveBeenCalledWith(s.mutationFetcher, "ns-1", [
      { cardId: "c1", posX: 1, posY: 2 },
    ]);
    expect(api.updateCard).toHaveBeenCalledWith(s.mutationFetcher, "ns-1", "c1", { width: 300 });
  });

  it("writes back the stored warp after a move", async () => {
    const s = state();
    s.warps = [{ id: "w1", namespaceId: "ns-1", posX: 0, posY: 0 }];
    const stored: Warp = { id: "w1", namespaceId: "ns-1", posX: 1000, posY: 800 };
    vi.mocked(api.moveWarp).mockResolvedValueOnce(succeeded);
    vi.mocked(api.parseWarp).mockReturnValueOnce(stored);

    await expect(
      createBoardPersistence(s).persistWarpPosition("w1", { posX: 1005, posY: 801 }),
    ).resolves.toBe(true);
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
    vi.mocked(api.moveScopeArea).mockResolvedValueOnce(succeeded);
    vi.mocked(api.parseScopeArea).mockReturnValueOnce(frame("a2", 600));

    const rect = { posX: 600, posY: 0, width: 200, height: 200 };
    await createBoardPersistence(s).persistScopeArea("s1", "a2", rect);
    expect(s.scopeAreas.map((a) => a.posX)).toEqual([0, 600]);
  });

  it("does not touch the board when a frame save is refused", async () => {
    const s = state();
    vi.mocked(api.moveScopeArea).mockResolvedValueOnce(failed);
    const rect = { posX: 0, posY: 0, width: 200, height: 200 };
    await expect(createBoardPersistence(s).persistScopeArea("s1", "a1", rect)).resolves.toBe(false);
    expect(api.parseScopeArea).not.toHaveBeenCalled();
  });

  describe("submitComposer", () => {
    it("saves an edit and closes the composer", async () => {
      const s = state();
      s.cards = [card("c1")];
      s.selection.composerCard = s.cards[0];
      vi.mocked(api.updateCard).mockResolvedValueOnce(succeeded);
      const placeNew = vi.fn();

      await createBoardPersistence(s).submitComposer("c1", "new text", "p2", placeNew);
      expect(s.cards[0]).toMatchObject({ content: "new text", partitionId: "p2" });
      expect(s.selection.composerCard).toBeNull();
      expect(placeNew).not.toHaveBeenCalled();
    });

    it("reports the server's reason when an edit is refused", async () => {
      const s = state();
      s.cards = [card("c1")];
      vi.mocked(api.updateCard).mockResolvedValueOnce(failed);
      vi.mocked(api.failureMessage).mockResolvedValueOnce("Too long");

      await createBoardPersistence(s).submitComposer("c1", "x", "p1", () => ({
        posX: 0,
        posY: 0,
      }));
      expect(s.lastError).toBe("Too long");
      expect(s.cards[0].content).toBe("c1");
    });

    it("creates a card above its layer, in the active scope, from the stored row", async () => {
      const s = state();
      s.cards = [card("c1", { zIndex: 4 }), card("c2", { layerId: "l2", zIndex: 9 })];
      s.activeLayerId = "l1";
      s.sidebar.activeScope = "s1";
      const created = card("c3", { posX: 10, posY: 20, zIndex: 5 });
      vi.mocked(api.createCard).mockResolvedValueOnce(succeeded);
      vi.mocked(api.parseCard).mockReturnValueOnce(created);

      await createBoardPersistence(s).submitComposer(null, "c3", "p1", () => ({
        posX: 10,
        posY: 20,
      }));
      expect(api.createCard).toHaveBeenCalledWith(s.mutationFetcher, "ns-1", {
        partitionId: "p1",
        content: "c3",
        posX: 10,
        posY: 20,
        zIndex: 5,
        scopeId: "s1",
        layerId: "l1",
      });
      expect(s.cards.at(-1)).toEqual(created);
      expect(s.scopeRels).toContainEqual({ scopeId: "s1", cardId: "c3" });
    });

    it("refuses a created card whose answer is not a row", async () => {
      const s = state();
      vi.mocked(api.createCard).mockResolvedValueOnce(succeeded);
      vi.mocked(api.parseCard).mockReturnValueOnce(null);

      await createBoardPersistence(s).submitComposer(null, "x", "p1", () => ({
        posX: 0,
        posY: 0,
      }));
      expect(s.lastError).toBe("Failed to create card");
      expect(s.cards).toEqual([]);
    });
  });
});
