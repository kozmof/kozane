import { describe, expect, it, vi } from "vitest";
import type { CardWithGlue, ScopeArea, Warp } from "$lib/types";
import { SCOPE_AREA_MIN_SIZE } from "$lib/constants";
import { SelectionState } from "../namespace-state.svelte.js";
import { BoardGestures, type BoardGestureHost } from "./board-gestures.svelte.js";
import { CanvasViewport } from "./canvas-viewport.js";
import type { WorldRect } from "./namespace-page.js";

function card(id: string, posX: number, posY: number): CardWithGlue {
  return {
    id,
    partitionId: "p1",
    layerId: "l1",
    content: id,
    posX,
    posY,
    zIndex: 0,
    glueId: null,
    taskspaceId: null,
    width: null,
  };
}

/**
 * An unscrolled board at the page origin and zoom 1 has matching client and world
 * coordinates.
 */
function fakeEl(): HTMLElement {
  return {
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 3000,
    scrollHeight: 2000,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    querySelectorAll: () => [],
    scrollBy() {},
  } as unknown as HTMLElement;
}

type Host = BoardGestureHost & {
  onPositionActivityStart: ReturnType<typeof vi.fn>;
  onPositionActivityEnd: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onFocusWarp: ReturnType<typeof vi.fn>;
  onPersistPositions: ReturnType<typeof vi.fn>;
  onPersistWidth: ReturnType<typeof vi.fn>;
  onPersistWarpPosition: ReturnType<typeof vi.fn>;
};

function hostWith(overrides: Partial<BoardGestureHost> = {}): Host {
  const el = fakeEl();
  const bounds = { canvasWidth: 3000, canvasHeight: 2000 };
  return {
    readonly: false,
    el,
    viewport: new CanvasViewport(
      () => el,
      () => 1,
      () => bounds,
    ),
    zoom: 1,
    bounds,
    cardWidth: 200,
    cards: [card("c1", 100, 100), card("c2", 400, 100)],
    warps: [] as Warp[],
    scopeAreas: [] as ScopeArea[],
    selection: new SelectionState(),
    glueGroupMap: new Map(),
    cardToGlue: new Map(),
    sweepableCardIds: new Set(),
    pendingScopeAreaRect: null as WorldRect | null,
    cardIdsInRect: () => new Set<string>(),
    onPositionActivityStart: vi.fn(),
    onPositionActivityEnd: vi.fn(),
    onError: vi.fn(),
    onFocusWarp: vi.fn(),
    onPersistPositions: vi.fn(async () => true),
    onPersistWidth: vi.fn(async () => true),
    onPersistWarpPosition: vi.fn(async () => true),
    onPersistScopeArea: vi.fn(async () => true),
    onScopeMembershipChange: vi.fn(async () => {}),
    ...overrides,
  } as Host;
}

function press(x: number, y: number, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent("mousedown", { button: 0, clientX: x, clientY: y, ...init });
}

describe("BoardGestures", () => {
  describe("the snapshot poll", () => {
    it("is held from a card press until its save has answered", async () => {
      const host = hostWith();
      let answer!: (ok: boolean) => void;
      host.onPersistPositions.mockReturnValueOnce(new Promise((r) => (answer = r)));
      const gestures = new BoardGestures(host);

      gestures.pressCard(press(110, 110), "c1");
      expect(host.onPositionActivityStart).toHaveBeenCalledTimes(1);
      gestures.move(200, 200);
      const released = gestures.release();
      await vi.waitFor(() => expect(host.onPersistPositions).toHaveBeenCalled());
      expect(host.onPositionActivityEnd).not.toHaveBeenCalled();

      answer(true);
      await released;
      expect(host.onPositionActivityEnd).toHaveBeenCalledTimes(1);
    });

    it("is given back when a press on the bare canvas abandons an open drag", () => {
      const host = hostWith();
      const gestures = new BoardGestures(host);
      gestures.pressCard(press(110, 110), "c1");
      gestures.pressCanvas(press(500, 500));
      expect(host.onPositionActivityEnd).toHaveBeenCalledTimes(1);
      expect(gestures.gesture?.kind).toBe("pan");
    });

    it("is not held for a pan, which commits nothing", async () => {
      const host = hostWith();
      const gestures = new BoardGestures(host);
      gestures.pressCanvas(press(500, 500));
      await gestures.release();
      expect(host.onPositionActivityStart).not.toHaveBeenCalled();
      expect(host.onPositionActivityEnd).not.toHaveBeenCalled();
    });
  });

  describe("presses", () => {
    it("refuses on a read-only board, off the primary button, and over an open gesture", () => {
      const readonly = new BoardGestures(hostWith({ readonly: true }));
      readonly.pressCard(press(110, 110), "c1");
      expect(readonly.gesture).toBeNull();

      const gestures = new BoardGestures(hostWith());
      gestures.pressCard(press(110, 110, { button: 2 }), "c1");
      expect(gestures.gesture).toBeNull();

      gestures.pressCard(press(110, 110), "c1");
      gestures.pressCard(press(410, 110), "c2");
      expect(gestures.draggingCardId).toBe("c1");
    });

    it("focuses a warp on a read-only board without arming a drag", () => {
      const host = hostWith({
        readonly: true,
        warps: [{ id: "w1", namespaceId: "n", posX: 0, posY: 0 }],
      });
      const gestures = new BoardGestures(host);
      gestures.pressWarp(press(0, 0), "w1");
      expect(host.onFocusWarp).toHaveBeenCalledWith("w1");
      expect(gestures.gesture).toBeNull();
    });
  });

  describe("card drags", () => {
    it("ignores a press that never travelled", async () => {
      const host = hostWith();
      const gestures = new BoardGestures(host);
      gestures.pressCard(press(110, 110), "c1");
      gestures.move(111, 111);
      await gestures.release();
      expect(host.onPersistPositions).not.toHaveBeenCalled();
    });

    it("snaps the dropped card to the grid and saves it", async () => {
      const host = hostWith();
      const gestures = new BoardGestures(host);
      gestures.pressCard(press(110, 110), "c1");
      gestures.move(205, 199);
      await gestures.release();
      expect(host.onPersistPositions).toHaveBeenCalledWith([
        { cardId: "c1", posX: 192, posY: 192 },
      ]);
      expect(host.cards[0]).toMatchObject({ posX: 192, posY: 192 });
    });

    it("puts the card back and says so when the save is refused", async () => {
      const host = hostWith();
      host.onPersistPositions.mockResolvedValueOnce(false);
      const gestures = new BoardGestures(host);
      gestures.pressCard(press(110, 110), "c1");
      gestures.move(300, 300);
      await gestures.release();
      expect(host.cards[0]).toMatchObject({ posX: 100, posY: 100 });
      expect(host.onError).toHaveBeenCalledWith("Failed to save card position");
    });
  });

  describe("card resizes", () => {
    it("puts the width back when the save is refused", async () => {
      const host = hostWith();
      host.onPersistWidth.mockResolvedValueOnce(false);
      const gestures = new BoardGestures(host);
      gestures.pressCardResize(press(300, 110), "c1");
      gestures.move(400, 110);
      expect(host.cards[0].width).toBe(300);
      await gestures.release();
      expect(host.cards[0].width).toBeNull();
      expect(host.onError).toHaveBeenCalledWith("Failed to save card width");
    });
  });

  describe("drawing a frame", () => {
    it("hands over a drawn rectangle, grown to the minimum size", async () => {
      const host = hostWith();
      const gestures = new BoardGestures(host);
      gestures.pressCanvas(press(50, 50, { altKey: true }));
      gestures.move(90, 80);
      expect(gestures.scopeAreaDraft).toEqual({ x: 50, y: 50, w: 40, h: 30 });
      await gestures.release();
      expect(gestures.scopeAreaDraft).toBeNull();
      expect(host.pendingScopeAreaRect).toEqual({
        x: 50,
        y: 50,
        w: SCOPE_AREA_MIN_SIZE,
        h: SCOPE_AREA_MIN_SIZE,
      });
    });

    it("drops an Alt-click that did not travel past the draw threshold", async () => {
      const host = hostWith();
      const gestures = new BoardGestures(host);
      gestures.pressCanvas(press(50, 50, { altKey: true }));
      gestures.move(55, 55);
      await gestures.release();
      expect(host.pendingScopeAreaRect).toBeNull();
    });
  });

  it("pans the board by how far the pointer has gone", () => {
    const host = hostWith();
    host.el.scrollLeft = 500;
    host.el.scrollTop = 400;
    const gestures = new BoardGestures(host);
    gestures.pressCanvas(press(300, 300));
    gestures.move(250, 320);
    expect(host.el.scrollLeft).toBe(550);
    expect(host.el.scrollTop).toBe(380);
  });
});
