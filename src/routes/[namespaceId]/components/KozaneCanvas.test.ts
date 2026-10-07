import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import KozaneCanvas from "./KozaneCanvas.svelte";
import CanvasBindingHarness from "./CanvasBindingHarness.svelte";
import { SelectionState } from "../namespace-state.svelte.js";
import { TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";
import { INACTIVE_LAYER_OPACITY } from "../lib/namespace-page.js";
import type { CardPositionPatch } from "../lib/namespace-page.js";
import { PALETTE } from "$lib/palette";
import { token } from "styled-system/tokens";
import type { NewCardPlacement } from "$lib/ui-config";
import type {
  PartitionWithColor,
  CardWithGlue,
  Layer,
  ScopeArea as ScopeAreaRow,
  TaskspaceSummary,
  Warp,
} from "$lib/types";
import { CARD_WIDTH_RANGE } from "$lib/ui-config";
import { STRIP_GAP } from "../lib/scope-area-files.js";

/**
 * Test canvas composition, layer rendering, warp behavior, and gesture wiring. Pure geometry
 * helpers have separate tests. Use browser tests for layout-dependent marquee and edge-scroll
 * behavior.
 */

const color = (id: string): PartitionWithColor => ({
  id,
  name: id,
  bg: PALETTE[0].bg,
  dot: PALETTE[0].dot,
  isDefault: false,
});

const layer = (id: string, position: number): Layer => ({
  id,
  namespaceId: "p1",
  name: id,
  position,
  isDefault: position === 0,
});

const card = (
  id: string,
  layerId: string,
  overrides: Partial<CardWithGlue> = {},
): CardWithGlue => ({
  id,
  partitionId: "b1",
  layerId,
  content: id,
  posX: 10,
  posY: 20,
  zIndex: 0,
  glueId: null,
  taskspaceId: null,
  width: null,
  ...overrides,
});

const warp = (id: string): Warp => ({ id, namespaceId: "p1", posX: 100, posY: 100 });

/**
 * Fail unexpected directory requests. Tests with framed taskspaces must supply their own
 * listing stub.
 */
const notFetched: typeof fetch = () => {
  throw new Error("unexpected fetch");
};

type Overrides = Record<string, unknown>;

function makeProps(overrides: Overrides = {}) {
  const cards = [card("c1", "l1")];
  return {
    cards,
    visibleCards: cards,
    glueRels: [],
    layers: [layer("l1", 0)],
    activeLayerId: "l1",
    partitionColorById: new Map([["b1", color("b1")]]),
    selection: new SelectionState(),
    scopeCardIds: null,
    scopeAreas: [],
    scopeNameById: new Map<string, string>(),
    activeScopeId: null,
    taskspaces: [],
    taskspaceTree: new TaskspaceTreeState(),
    treeContext: { fetcher: notFetched, namespaceId: "p1" },
    pendingScopeAreaRect: null,
    onRemoveScopeArea: vi.fn(),
    onPersistScopeArea: vi.fn(
      async (
        _scopeId: string,
        _areaId: string,
        _rect: { posX: number; posY: number; width: number; height: number },
      ) => true,
    ),
    onScopeMembershipChange: vi.fn(
      async (_scopeId: string, _change: { entered: string[]; exited: string[] }) => {},
    ),
    warps: [],
    focusedWarpId: null,
    warpsVisible: true,
    warpMarkerSize: 24,
    initialCenter: null,
    onFocusWarp: vi.fn(),
    onPersistWarpPosition: vi.fn(
      async (_warpId: string, _position: { posX: number; posY: number }) => true,
    ),
    showFooters: true,
    zoom: 1,
    zoomStep: 0.1,
    canvasWidth: 5600,
    canvasHeight: 4000,
    cardWidth: 240,
    newCardPlacement: "grid" as NewCardPlacement,
    fontSize: 11.5,
    fontFamily: "sans-serif",
    onPersistPositions: vi.fn(async (_positions: CardPositionPatch[]) => true),
    onPersistWidth: vi.fn(async (_cardId: string, _width: number) => true),
    onPositionActivityStart: vi.fn(),
    onPositionActivityEnd: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

/** The layer wrappers, in DOM order, keyed by the id the template stamps on each. */
function layerWrappers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-layer-id]")];
}

function wrapperFor(container: HTMLElement, layerId: string): HTMLElement {
  const found = layerWrappers(container).find((el) => el.dataset.layerId === layerId);
  if (!found) throw new Error(`no wrapper for layer "${layerId}"`);
  return found;
}

const cardIdsIn = (wrapper: HTMLElement) =>
  [...wrapper.querySelectorAll<HTMLElement>("[data-card-id]")].map((el) => el.dataset.cardId);

describe("KozaneCanvas layer grouping", () => {
  it("renders each card inside the wrapper for its own layer", () => {
    const cards = [card("c1", "l1"), card("c2", "l2"), card("c3", "l1")];
    const { container } = render(KozaneCanvas, {
      props: makeProps({
        cards,
        visibleCards: cards,
        layers: [layer("l1", 0), layer("l2", 1)],
        activeLayerId: "l1",
      }),
    });

    expect(cardIdsIn(wrapperFor(container, "l1"))).toEqual(["c1", "c3"]);
    expect(cardIdsIn(wrapperFor(container, "l2"))).toEqual(["c2"]);
  });

  // Render a card with a missing layer on the topmost effective layer, including active-layer
  // promotion.
  it("draws a card whose layer is missing on the topmost layer of the stack", () => {
    const cards = [card("orphan", "deleted-layer")];
    const { container } = render(KozaneCanvas, {
      props: makeProps({
        cards,
        visibleCards: cards,
        layers: [layer("l1", 0), layer("l2", 1)],
        // The lower of the two by position, so this cannot pass by landing on "the last
        // layer declared" and happening to agree.
        activeLayerId: "l1",
      }),
    });

    const topmost = layerWrappers(container).reduce((highest, el) =>
      Number(el.style.zIndex) > Number(highest.style.zIndex) ? el : highest,
    );
    expect(topmost.dataset.layerId).toBe("l1");
    expect(cardIdsIn(topmost)).toEqual(["orphan"]);
  });

  // An older static export carries no layers at all. One flat sheet, as the board drew
  // before layers existed, rather than nothing.
  it("falls back to a single flat sheet when the namespace has no layers", () => {
    const cards = [card("c1", "l1"), card("c2", "l2")];
    const { container } = render(KozaneCanvas, {
      props: makeProps({ cards, visibleCards: cards, layers: [], activeLayerId: null }),
    });

    const wrappers = layerWrappers(container);
    expect(wrappers).toHaveLength(1);
    expect(cardIdsIn(wrappers[0])).toEqual(["c1", "c2"]);
  });

  it("gives the inactive layers the dimmed opacity and the active one full strength", () => {
    const cards = [card("c1", "l1"), card("c2", "l2")];
    const { container } = render(KozaneCanvas, {
      props: makeProps({
        cards,
        visibleCards: cards,
        layers: [layer("l1", 0), layer("l2", 1)],
        activeLayerId: "l2",
      }),
    });

    expect(wrapperFor(container, "l2").style.opacity).toBe("1");
    expect(wrapperFor(container, "l1").style.opacity).toBe(String(INACTIVE_LAYER_OPACITY));
  });

  // Layer wrapper z-index controls inter-layer order. Card z-index orders cards only within
  // their layer.
  it("lifts the active layer above the rest, whatever zIndex its cards carry", () => {
    const cards = [card("c1", "l1", { zIndex: 0 }), card("c2", "l2", { zIndex: 99 })];
    const { container } = render(KozaneCanvas, {
      props: makeProps({
        cards,
        visibleCards: cards,
        layers: [layer("l1", 0), layer("l2", 1)],
        // Active is the lower layer by position, so a stack that merely followed
        // `position` would put l2 on top and fail this.
        activeLayerId: "l1",
      }),
    });

    const active = Number(wrapperFor(container, "l1").style.zIndex);
    const other = Number(wrapperFor(container, "l2").style.zIndex);
    expect(active).toBeGreaterThan(other);
  });

  // Non-active layers keep their own bottom-to-top order underneath.
  it("keeps the inactive layers in position order below the active one", () => {
    const cards = [card("c1", "l1"), card("c2", "l2"), card("c3", "l3")];
    const { container } = render(KozaneCanvas, {
      props: makeProps({
        cards,
        visibleCards: cards,
        layers: [layer("l1", 0), layer("l2", 1), layer("l3", 2)],
        activeLayerId: "l2",
      }),
    });

    const z = (id: string) => Number(wrapperFor(container, id).style.zIndex);
    expect(z("l1")).toBeLessThan(z("l3"));
    expect(z("l3")).toBeLessThan(z("l2"));
  });
});

describe("KozaneCanvas warps", () => {
  // A warp marks a place on the board, not a place on one of its layers, so it is rendered
  // outside every layer wrapper and never dims with them.
  it("renders warp markers outside the layer wrappers", () => {
    const { container } = render(KozaneCanvas, {
      props: makeProps({ warps: [warp("w1")], warpsVisible: true }),
    });

    const marker = container.querySelector<HTMLElement>('[data-warp-id="w1"]');
    expect(marker).not.toBeNull();
    expect(marker!.closest("[data-layer-id]")).toBeNull();
  });

  it("draws no markers while warps are hidden", () => {
    const { container } = render(KozaneCanvas, {
      props: makeProps({ warps: [warp("w1")], warpsVisible: false }),
    });

    expect(container.querySelector('[data-warp-id="w1"]')).toBeNull();
  });

  it("numbers the markers by creation order", () => {
    const { getByLabelText } = render(KozaneCanvas, {
      props: makeProps({ warps: [warp("w1"), warp("w2")], warpsVisible: true }),
    });

    expect(getByLabelText("Warp 1")).toHaveAttribute("data-warp-id", "w1");
    expect(getByLabelText("Warp 2")).toHaveAttribute("data-warp-id", "w2");
  });

  it("marks only the focused warp as pressed", () => {
    const { getByLabelText } = render(KozaneCanvas, {
      props: makeProps({ warps: [warp("w1"), warp("w2")], focusedWarpId: "w2" }),
    });

    expect(getByLabelText("Warp 1")).toHaveAttribute("aria-pressed", "false");
    expect(getByLabelText("Warp 2")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("KozaneCanvas selection and scope", () => {
  it("marks the cards the selection holds as pressed", () => {
    const selection = new SelectionState();
    selection.selectedCards = new Set(["c2"]);
    const cards = [card("c1", "l1"), card("c2", "l1")];

    const { container } = render(KozaneCanvas, {
      props: makeProps({ cards, visibleCards: cards, selection }),
    });

    const pressed = [...container.querySelectorAll<HTMLElement>("[data-card-id]")]
      .filter((el) => el.getAttribute("aria-pressed") === "true")
      .map((el) => el.dataset.cardId);
    expect(pressed).toEqual(["c2"]);
  });

  // Render only `visibleCards`. Filtered cards should be absent from the DOM.
  it("draws only the cards handed to it as visible", () => {
    const cards = [card("c1", "l1"), card("c2", "l1")];
    const { container } = render(KozaneCanvas, {
      props: makeProps({ cards, visibleCards: [cards[0]] }),
    });

    expect(
      [...container.querySelectorAll<HTMLElement>("[data-card-id]")].map((el) => el.dataset.cardId),
    ).toEqual(["c1"]);
  });
});

/**
 * Test dragging and resizing through the component. Relative pointer deltas remain measurable
 * in jsdom even with zero element rectangles. Layout-dependent interactions need separate
 * browser coverage.
 */

const down = (target: Element, clientX: number, clientY: number, init: MouseEventInit = {}) =>
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button: 0, clientX, clientY, ...init }),
  );

const move = (clientX: number, clientY: number) =>
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));

const up = () => window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

/** Wait for persistence to settle before checking rollback. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Omit `cards`, `zoom`, and `visibleCards` because {@link CanvasBindingHarness} owns their
 * state and derivation.
 */
function boundProps(overrides: Overrides = {}) {
  const {
    cards,
    visibleCards: _visible,
    zoom: _zoom,
    pendingScopeAreaRect: _pending,
    ...props
  } = makeProps(overrides);
  return { initialCards: cards, props };
}

function cardEl(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  if (!found) throw new Error(`no card "${id}"`);
  return found;
}

function resizeHandle(container: HTMLElement, id: string): HTMLElement {
  const found = cardEl(container, id).querySelector<HTMLElement>("[data-resize-handle]");
  if (!found) throw new Error(`card "${id}" is not showing a resize handle`);
  return found;
}

describe("KozaneCanvas dragging", () => {
  it("moves the card by the pointer's travel and saves where it landed", async () => {
    const props = makeProps();
    const { container } = render(KozaneCanvas, props);

    down(cardEl(container, "c1"), 100, 100);
    move(160, 140);
    up();
    await settle();

    // Snap 70 and 60 to the nearest grid point, 72.
    expect(props.cards[0].posX).toBe(72);
    expect(props.cards[0].posY).toBe(72);
    expect(props.onPersistPositions).toHaveBeenCalledWith([{ cardId: "c1", posX: 72, posY: 72 }]);
  });

  // The threshold that separates a drag from a click. Without it every click on a card
  // would write a position, and the click handler would be racing a save.
  it("does not save a press that never travelled", async () => {
    const props = makeProps();
    const { container } = render(KozaneCanvas, props);

    down(cardEl(container, "c1"), 100, 100);
    move(102, 101);
    up();
    await settle();

    expect(props.onPersistPositions).not.toHaveBeenCalled();
    // Below-threshold movement is drawn but not snapped or saved. The next snapshot restores
    // the stored position.
    expect(props.cards[0].posX).toBe(12);
  });

  it("moves a glued card's whole group, and saves every one of them", async () => {
    const cards = [
      card("c1", "l1", { glueId: "g1" }),
      card("c2", "l1", { glueId: "g1", posX: 100, posY: 200 }),
      card("c3", "l1", { posX: 500, posY: 500 }),
    ];
    const props = makeProps({
      cards,
      visibleCards: cards,
      glueRels: [
        { glueId: "g1", cardId: "c1" },
        { glueId: "g1", cardId: "c2" },
      ],
    });
    const { container } = render(KozaneCanvas, props);

    down(cardEl(container, "c1"), 0, 0);
    move(48, 0);
    up();
    await settle();

    // Snap the dragged card and move the whole group by the same offset to preserve spacing.
    expect(cards[0].posX).toBe(48);
    expect(cards[1].posX).toBe(138);
    expect(cards[1].posX - cards[0].posX).toBe(100 - 10);
    // A card outside the group does not move, and is not saved.
    expect(cards[2].posX).toBe(500);
    const saved = props.onPersistPositions.mock.calls[0][0];
    expect(saved.map(({ cardId }) => cardId).sort()).toEqual(["c1", "c2"]);
  });

  it("holds the snapshot poll off for the length of the drag", async () => {
    const props = makeProps();
    const { container } = render(KozaneCanvas, props);

    down(cardEl(container, "c1"), 100, 100);
    move(160, 100);
    expect(props.onPositionActivityStart).toHaveBeenCalledTimes(1);
    // Keep position activity open during the save so polling cannot replace the dragged card
    // list.
    expect(props.onPositionActivityEnd).not.toHaveBeenCalled();
    up();
    await settle();

    expect(props.onPositionActivityEnd).toHaveBeenCalledTimes(1);
  });

  // Verify rollback to the drag's original position through the binding harness. Rollback
  // replaces the array, so the parent binding must observe it.
  it("puts the card back where it was when the save fails", async () => {
    const { initialCards, props } = boundProps({
      onPersistPositions: vi.fn(async (_positions: CardPositionPatch[]) => false),
    });
    const { container, component } = render(CanvasBindingHarness, { initialCards, ...props });

    down(cardEl(container, "c1"), 100, 100);
    move(400, 400);
    up();
    await settle();

    const [restored] = component.read();
    expect(restored.posX).toBe(10);
    expect(restored.posY).toBe(20);
    expect(props.onError).toHaveBeenCalledWith("Failed to save card position");
  });

  it("ignores a drag on a read-only board", async () => {
    const props = makeProps({ readonly: true });
    const { container } = render(KozaneCanvas, props);

    down(cardEl(container, "c1"), 100, 100);
    move(200, 200);
    up();
    await settle();

    expect(props.cards[0].posX).toBe(10);
    expect(props.onPersistPositions).not.toHaveBeenCalled();
    expect(props.onPositionActivityStart).not.toHaveBeenCalled();
  });
});

describe("KozaneCanvas warp dragging", () => {
  function warpEl(container: HTMLElement, id: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-warp-id="${id}"]`);
    if (!found) throw new Error(`no warp "${id}"`);
    return found;
  }

  it("moves the marker by the pointer's travel and saves where it landed", async () => {
    const warps = [warp("w1")];
    const props = makeProps({ warps });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);
    move(160, 140);
    up();
    await settle();

    // Move the warp to 160, 140 without snapping to the card grid.
    expect(warps[0]).toMatchObject({ posX: 160, posY: 140 });
    expect(props.onPersistWarpPosition).toHaveBeenCalledWith("w1", { posX: 160, posY: 140 });
  });

  // Pressing a marker has always focused its warp, which is what the remove shortcut acts
  // on. Arming a drag must not have taken that away.
  it("focuses the warp on the press itself", () => {
    const props = makeProps({ warps: [warp("w1")] });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);

    expect(props.onFocusWarp).toHaveBeenCalledWith("w1");
  });

  it("does not save a press that never travelled", async () => {
    const props = makeProps({ warps: [warp("w1")] });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);
    move(102, 101);
    up();
    await settle();

    expect(props.onPersistWarpPosition).not.toHaveBeenCalled();
  });

  it("holds a marker dragged past the edge on the board", async () => {
    const warps = [warp("w1")];
    const props = makeProps({ warps });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);
    move(-500, -500);
    up();
    await settle();

    expect(warps[0]).toMatchObject({ posX: 0, posY: 0 });
    expect(props.onPersistWarpPosition).toHaveBeenCalledWith("w1", { posX: 0, posY: 0 });
  });

  it("holds the snapshot poll off for the length of the drag", async () => {
    const props = makeProps({ warps: [warp("w1")] });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);
    move(160, 140);
    expect(props.onPositionActivityStart).toHaveBeenCalledTimes(1);
    expect(props.onPositionActivityEnd).not.toHaveBeenCalled();

    up();
    await settle();
    expect(props.onPositionActivityEnd).toHaveBeenCalledTimes(1);
  });

  // Restore the marker and report a failed save. This rollback writes through the row and
  // needs no binding harness.
  it("puts the marker back where it was when the save fails", async () => {
    const warps = [warp("w1")];
    const props = makeProps({
      warps,
      onPersistWarpPosition: vi.fn(async (_warpId: string, _position: unknown) => false),
    });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);
    move(400, 400);
    up();
    await settle();

    expect(warps[0]).toMatchObject({ posX: 100, posY: 100 });
    expect(props.onError).toHaveBeenCalledWith("Failed to save warp position");
  });

  it("leaves a marker where it is on a read-only board, and still focuses it", async () => {
    const warps = [warp("w1")];
    const props = makeProps({ warps, readonly: true });
    const { container } = render(KozaneCanvas, props);

    down(warpEl(container, "w1"), 100, 100);
    move(200, 200);
    up();
    await settle();

    expect(warps[0]).toMatchObject({ posX: 100, posY: 100 });
    expect(props.onPersistWarpPosition).not.toHaveBeenCalled();
    expect(props.onPositionActivityStart).not.toHaveBeenCalled();
    expect(props.onFocusWarp).toHaveBeenCalledWith("w1");
  });
});

describe("KozaneCanvas resizing", () => {
  /** The handle is only drawn for the card the resize shortcut armed. */
  function armed(overrides: Overrides = {}) {
    const selection = new SelectionState();
    selection.selectedCards = new Set(["c1"]);
    selection.resizingCardId = "c1";
    return makeProps({ selection, ...overrides });
  }

  it("widens the card by the drag and saves the width it settled on", async () => {
    const props = armed();
    const { container } = render(KozaneCanvas, props);

    down(resizeHandle(container, "c1"), 300, 0);
    move(360, 0);
    up();
    await settle();

    // Snap the new width of 300 to 312 on release.
    expect(props.cards[0].width).toBe(312);
    expect(props.onPersistWidth).toHaveBeenCalledWith("c1", 312);
  });

  // Clamp the drag to the allowed range before sending it to the server.
  it("stops at the ends of the width range however far the pointer goes", async () => {
    const props = armed();
    const { container } = render(KozaneCanvas, props);

    down(resizeHandle(container, "c1"), 0, 0);
    move(-5000, 0);
    up();
    await settle();

    expect(props.cards[0].width).toBe(CARD_WIDTH_RANGE[0]);
  });

  // A card with no width of its own follows `ui.defaultCardWidth`, and a failed resize has
  // to leave it doing that rather than pinning it at the width it was drawn.
  it("returns the card to following the default width when the save fails", async () => {
    const selection = new SelectionState();
    selection.selectedCards = new Set(["c1"]);
    selection.resizingCardId = "c1";
    const { initialCards, props } = boundProps({
      selection,
      onPersistWidth: vi.fn(async (_cardId: string, _width: number) => false),
    });
    const { container, component } = render(CanvasBindingHarness, { initialCards, ...props });

    down(resizeHandle(container, "c1"), 300, 0);
    move(400, 0);
    up();
    await settle();

    expect(component.read()[0].width).toBeNull();
    expect(props.onError).toHaveBeenCalledWith("Failed to save card width");
  });
});

/**
 * Test scope membership updates around frame and card gestures. Supply element rectangles in
 * jsdom and rely on separate pure-function tests for overlap calculations.
 */
const scopeArea = (overrides: Partial<ScopeAreaRow> = {}): ScopeAreaRow => ({
  id: "a1",
  scopeId: "s1",
  namespaceId: "p1",
  posX: 100,
  posY: 200,
  width: 640,
  height: 480,
  ...overrides,
});

/**
 * Derive a mock rectangle from rendered styles so it moves only after Svelte flushes the DOM.
 * This detects measurements taken before the updated position is visible.
 */
function layOutFromStyle(el: HTMLElement, w: number, h: number) {
  el.getBoundingClientRect = () => {
    const x = Number.parseFloat(el.style.left) || 0;
    const y = Number.parseFloat(el.style.top) || 0;
    return {
      left: x,
      top: y,
      right: x + w,
      bottom: y + h,
      width: w,
      height: h,
      x,
      y,
    } as DOMRect;
  };
}

/** Gives an element the box it would have if the browser had laid it out. */
function layOut(el: Element, box: { x: number; y: number; w: number; h: number }) {
  el.getBoundingClientRect = () =>
    ({
      left: box.x,
      top: box.y,
      right: box.x + box.w,
      bottom: box.y + box.h,
      width: box.w,
      height: box.h,
      x: box.x,
      y: box.y,
    }) as DOMRect;
}

describe("KozaneCanvas scope areas", () => {
  function areaTab(container: HTMLElement, scopeId: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      `[data-scope-id="${scopeId}"] button[aria-label^="Scope area"]`,
    );
    if (!found) throw new Error(`no scope area tab for "${scopeId}"`);
    return found;
  }

  function areaHandle(container: HTMLElement, scopeId: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      `[data-scope-id="${scopeId}"] button[aria-label^="Resize scope area"]`,
    );
    if (!found) throw new Error(`no scope area handle for "${scopeId}"`);
    return found;
  }

  function areaProps(overrides: Overrides = {}) {
    return makeProps({
      scopeAreas: [scopeArea()],
      scopeNameById: new Map([["s1", "Now"]]),
      ...overrides,
    });
  }

  it("draws a frame for each scope area", () => {
    const { container } = render(KozaneCanvas, areaProps());
    expect(container.querySelector("[data-scope-area-id='a1']")).not.toBeNull();
  });

  it("moves the frame with the pointer and saves where it landed", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);

    down(areaTab(container, "s1"), 100, 100);
    move(148, 148);
    up();
    await settle();

    // Snap the movement delta so the frame and its cards retain their existing grid
    // alignment.
    expect(props.scopeAreas[0]).toMatchObject({ posX: 148, posY: 248 });
    expect(props.onPersistScopeArea).toHaveBeenCalledWith("s1", "a1", {
      posX: 148,
      posY: 248,
      width: 640,
      height: 480,
    });
  });

  it("carries the cards inside it", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    // Inside the frame, which stands at (100, 200) 640×480.
    layOut(cardEl(container, "c1"), { x: 150, y: 250, w: 240, h: 80 });

    down(areaTab(container, "s1"), 100, 100);
    move(148, 148);
    up();
    await settle();

    // Moved by the same delta as the frame, from (10, 20).
    expect(props.cards[0]).toMatchObject({ posX: 58, posY: 68 });
    expect(props.onPersistPositions).toHaveBeenCalledWith([{ cardId: "c1", posX: 58, posY: 68 }]);
  });

  it("leaves a card outside the frame where it is", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    layOut(cardEl(container, "c1"), { x: 0, y: 0, w: 240, h: 80 });

    down(areaTab(container, "s1"), 100, 100);
    move(148, 148);
    up();
    await settle();

    expect(props.cards[0]).toMatchObject({ posX: 10, posY: 20 });
  });

  it("files a card dragged into the frame into the scope", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    const el = cardEl(container, "c1");
    layOut(el, { x: 0, y: 0, w: 240, h: 80 });

    down(el, 100, 100);
    // The card's drawn box follows it, which on a real board is what the browser does.
    layOut(el, { x: 150, y: 250, w: 240, h: 80 });
    move(200, 200);
    up();
    await settle();

    expect(props.onScopeMembershipChange).toHaveBeenCalledWith("s1", {
      entered: ["c1"],
      exited: [],
    });
  });

  it("files a card dragged out of the frame out of the scope", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    const el = cardEl(container, "c1");
    layOut(el, { x: 150, y: 250, w: 240, h: 80 });

    down(el, 100, 100);
    layOut(el, { x: 0, y: 0, w: 240, h: 80 });
    move(200, 200);
    up();
    await settle();

    expect(props.onScopeMembershipChange).toHaveBeenCalledWith("s1", {
      entered: [],
      exited: ["c1"],
    });
  });

  it("says nothing about a card that stayed outside the frame", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    const el = cardEl(container, "c1");
    layOut(el, { x: 0, y: 0, w: 240, h: 80 });

    down(el, 100, 100);
    layOut(el, { x: 20, y: 20, w: 240, h: 80 });
    move(200, 200);
    up();
    await settle();

    // Change membership only when a card crosses a frame boundary. Cards assigned through the
    // sidebar or CLI may belong to a scope without being inside its frame.
    expect(props.onScopeMembershipChange).not.toHaveBeenCalled();
  });

  it("does not file anything when the position save fails", async () => {
    const props = areaProps({
      onPersistPositions: vi.fn(async (_positions: CardPositionPatch[]) => false),
    });
    const { container } = render(KozaneCanvas, props);
    const el = cardEl(container, "c1");
    layOut(el, { x: 0, y: 0, w: 240, h: 80 });

    down(el, 100, 100);
    layOut(el, { x: 150, y: 250, w: 240, h: 80 });
    move(200, 200);
    up();
    await settle();

    // A card filed into a scope at a position the server refused would be a member of it
    // while sitting somewhere else entirely.
    expect(props.onScopeMembershipChange).not.toHaveBeenCalled();
  });

  it("does not file its own members out of the scope when the frame is dragged away", async () => {
    // Move the frame and its contained card through the reactive harness. The mock box
    // follows rendered styles, so measuring before Svelte flushes would incorrectly report
    // that the card left the scope.
    const { cards: initialCards, ...props } = areaProps({
      cards: [card("c1", "l1", { posX: 150, posY: 250 })],
    });
    const { visibleCards: _visible, zoom: _zoom, ...rest } = props;
    const { container } = render(CanvasBindingHarness, { initialCards, ...rest });
    layOutFromStyle(cardEl(container, "c1"), 240, 80);

    down(areaTab(container, "s1"), 100, 100);
    move(1000, 900);
    up();
    await settle();

    expect(props.onScopeMembershipChange).not.toHaveBeenCalled();
  });

  it("resizes the frame from its far corner and saves the new size", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);

    down(areaHandle(container, "s1"), 0, 0);
    move(48, 24);
    up();
    await settle();

    expect(props.onPersistScopeArea).toHaveBeenCalledWith("s1", "a1", {
      // Keep the frame's origin fixed during resizing to preserve its position relative to
      // its cards.
      posX: 100,
      posY: 200,
      width: 696,
      height: 504,
    });
  });

  it("lets a card out when the frame is shrunk past it", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    // This card is inside the 640-by-480 frame but outside the smaller frame.
    layOut(cardEl(container, "c1"), { x: 600, y: 600, w: 240, h: 80 });

    down(areaHandle(container, "s1"), 0, 0);
    move(-480, -360);
    up();
    await settle();

    expect(props.onScopeMembershipChange).toHaveBeenCalledWith("s1", {
      entered: [],
      exited: ["c1"],
    });
  });

  it("takes a card in when the frame is grown over it", async () => {
    const props = areaProps();
    const { container } = render(KozaneCanvas, props);
    // Outside the frame's far corner at 640×480, inside once it is grown.
    layOut(cardEl(container, "c1"), { x: 800, y: 700, w: 240, h: 80 });

    down(areaHandle(container, "s1"), 0, 0);
    move(480, 360);
    up();
    await settle();

    expect(props.onScopeMembershipChange).toHaveBeenCalledWith("s1", {
      entered: ["c1"],
      exited: [],
    });
  });

  it("puts the frame back when the save fails", async () => {
    const props = areaProps({
      onPersistScopeArea: vi.fn(async (_scopeId: string, _rect: unknown) => false),
    });
    const { container } = render(KozaneCanvas, props);

    down(areaTab(container, "s1"), 100, 100);
    move(148, 148);
    up();
    await settle();

    expect(props.scopeAreas[0]).toMatchObject({ posX: 100, posY: 200 });
    expect(props.onError).toHaveBeenCalledWith("Failed to save scope area");
  });

  it("ignores a frame drag on a read-only board", async () => {
    const props = areaProps({ readonly: true });
    const { container } = render(KozaneCanvas, props);

    down(areaTab(container, "s1"), 100, 100);
    move(200, 200);
    up();
    await settle();

    expect(props.scopeAreas[0]).toMatchObject({ posX: 100, posY: 200 });
    expect(props.onPersistScopeArea).not.toHaveBeenCalled();
  });
});

/**
 * Test Alt-drag ownership, the draw threshold, and the pending frame rectangle. Rectangle
 * arithmetic has separate tests.
 */
describe("KozaneCanvas scope area drawing", () => {
  function surface(container: HTMLElement): Element {
    const found = container.querySelector("[data-canvas-surface]");
    if (!found) throw new Error("no canvas surface");
    return found;
  }

  /** An Alt-drag across the board, which is what draws a frame. */
  function draw(container: HTMLElement, from: [number, number], to: [number, number]) {
    down(surface(container), from[0], from[1], { altKey: true });
    move(to[0], to[1]);
    up();
  }

  /** Rendered through the harness, which is the only way a binding write is observable. */
  function mountBound(overrides: Overrides = {}) {
    const { initialCards, props } = boundProps(overrides);
    const rendered = render(CanvasBindingHarness, { initialCards, ...props });
    return { ...rendered, props };
  }

  it("hands the drawn rectangle over on release", async () => {
    const { container, component } = mountBound();

    draw(container, [100, 100], [500, 460]);
    await settle();

    // The rectangle the pointer described, rounded to the integers the columns are.
    expect(component.readPendingRect()).toEqual({ x: 100, y: 100, w: 400, h: 360 });
  });

  it("grows a rectangle drawn smaller than the minimum up to it", async () => {
    const { container, component } = mountBound();

    draw(container, [100, 100], [140, 130]);
    await settle();

    // Expand a valid draw below the minimum frame size so its handles remain usable.
    expect(component.readPendingRect()).toMatchObject({ w: 120, h: 120 });
  });

  it("asks nothing for an Alt-click that went nowhere", async () => {
    const { container, component } = mountBound();

    draw(container, [100, 100], [104, 102]);
    await settle();

    expect(component.readPendingRect()).toBeNull();
  });

  it("does not sweep a selection while drawing", async () => {
    const selection = new SelectionState();
    const { container } = mountBound({ selection });

    draw(container, [100, 100], [500, 460]);
    await settle();

    // Alt takes priority over Shift. Drawing a frame must not move the board's contents.
    expect(selection.selectedCards.size).toBe(0);
  });

  it("ignores a draw on a read-only board", async () => {
    const { container, component } = mountBound({ readonly: true });

    draw(container, [100, 100], [500, 460]);
    await settle();

    expect(component.readPendingRect()).toBeNull();
  });

  /** The one absolutely-positioned box drawn at these coordinates, if any. */
  function rectAt(
    container: HTMLElement,
    at: { left: string; top: string; width: string },
  ): HTMLElement | undefined {
    return [...container.querySelectorAll<HTMLElement>("div")].find(
      (el) => el.style.left === at.left && el.style.top === at.top && el.style.width === at.width,
    );
  }

  /**
   * Compare against `token.var` because jsdom preserves unresolved custom properties and
   * cannot detect an invalid token name itself.
   */
  it("draws the rectangle while it is still being dragged", async () => {
    const { container } = mountBound();

    down(surface(container), 100, 100, { altKey: true });
    move(500, 460);
    // Wait for Svelte's DOM update before asserting the in-progress draw.
    await settle();

    // Show the rectangle during the drag so the user can place it accurately.
    const drawn = rectAt(container, { left: "100px", top: "100px", width: "400px" });
    expect(drawn).not.toBeUndefined();
    expect(drawn!.style.border).toBe(`1px solid ${token.var("colors.neutral.iconDim")}`);

    up();
  });

  it("draws the rectangle still waiting for a scope", () => {
    const { container } = render(
      KozaneCanvas,
      makeProps({ pendingScopeAreaRect: { x: 40, y: 60, w: 300, h: 200 } }),
    );

    // Keep the rectangle visible while the prompt asks which scope it frames.
    const drawn = rectAt(container, { left: "40px", top: "60px", width: "300px" });
    expect(drawn).not.toBeUndefined();
    expect(drawn!.style.border).toBe(`1px solid ${token.var("colors.neutral.iconDim")}`);
  });
});

/**
 * Several frames for one scope, which is the case the membership rule has to get right.
 *
 * A scope's members are measured against everything it covers, not against each frame in
 * turn. Asked per frame, a card that merely stopped overlapping one of them would read as
 * having left the scope it is plainly still sitting in.
 */
describe("KozaneCanvas scope areas: several frames per scope", () => {
  const twoFrames = [
    scopeArea({ id: "a1", scopeId: "s1", posX: 0, posY: 0, width: 400, height: 400 }),
    scopeArea({ id: "a2", scopeId: "s1", posX: 1000, posY: 0, width: 400, height: 400 }),
  ];

  function mountTwo(overrides: Overrides = {}) {
    return makeProps({
      scopeAreas: twoFrames,
      scopeNameById: new Map([["s1", "Now"]]),
      ...overrides,
    });
  }

  it("draws a frame for each", () => {
    const { container } = render(KozaneCanvas, mountTwo());
    expect(container.querySelectorAll("[data-scope-area-id]")).toHaveLength(2);
  });

  it("says nothing when a card moves from one of a scope's frames to another", async () => {
    const props = mountTwo();
    const { container } = render(KozaneCanvas, props);
    const el = cardEl(container, "c1");
    layOut(el, { x: 50, y: 50, w: 240, h: 80 });

    down(el, 100, 100);
    // Move between frames of the same scope without leaving its membership.
    layOut(el, { x: 1050, y: 50, w: 240, h: 80 });
    move(200, 200);
    up();
    await settle();

    expect(props.onScopeMembershipChange).not.toHaveBeenCalled();
  });

  it("files a card out only once it has left every frame of the scope", async () => {
    const props = mountTwo();
    const { container } = render(KozaneCanvas, props);
    const el = cardEl(container, "c1");
    layOut(el, { x: 50, y: 50, w: 240, h: 80 });

    down(el, 100, 100);
    layOut(el, { x: 2000, y: 2000, w: 240, h: 80 });
    move(200, 200);
    up();
    await settle();

    expect(props.onScopeMembershipChange).toHaveBeenCalledWith("s1", {
      entered: [],
      exited: ["c1"],
    });
  });

  it("keeps a card in the scope when the frame it is not in is shrunk away", async () => {
    const props = mountTwo();
    const { container } = render(KozaneCanvas, props);
    // Inside the second frame only.
    layOut(cardEl(container, "c1"), { x: 1050, y: 50, w: 240, h: 80 });

    // Shrink the first frame, which the card was never in.
    down(
      container.querySelector<HTMLElement>(
        "[data-scope-area-id='a1'] button[aria-label^='Resize']",
      )!,
      0,
      0,
    );
    move(-240, -240);
    up();
    await settle();

    expect(props.onScopeMembershipChange).not.toHaveBeenCalled();
  });

  it("reports the frame that moved, not the scope", async () => {
    const props = mountTwo();
    const { container } = render(KozaneCanvas, props);

    down(areaTabFor(container, "a2"), 100, 100);
    move(148, 148);
    up();
    await settle();

    // Move only the requested area ID, leaving the scope's other frame unchanged.
    expect(props.onPersistScopeArea).toHaveBeenCalledWith("s1", "a2", expect.any(Object));
    expect(props.scopeAreas[0]).toMatchObject({ id: "a1", posX: 0, posY: 0 });
  });

  it("removes the frame whose button was pressed", async () => {
    const props = mountTwo();
    const { container } = render(KozaneCanvas, props);

    const remove = container.querySelector<HTMLElement>(
      "[data-scope-area-id='a2'] button[aria-label^='Remove frame']",
    )!;
    remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    expect(props.onRemoveScopeArea).toHaveBeenCalledWith("s1", "a2");
  });
});

/** The drag tab of one particular frame. */
function areaTabFor(container: HTMLElement, areaId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[data-scope-area-id="${areaId}"] button[aria-label^="Scope area"]`,
  );
  if (!found) throw new Error(`no tab for area "${areaId}"`);
  return found;
}

/**
 * Test frame file-strip integration, including eager loading, following frame movement, and
 * independent folder navigation for frames sharing a scope.
 */
describe("KozaneCanvas scope area files", () => {
  const taskspace = (id: string, name: string, scopeId: string): TaskspaceSummary => ({
    id,
    name,
    scopeId,
    path: name,
    pathKind: "workspace_relative",
  });

  /** A listing endpoint that answers from a map of path to names, and records what was asked. */
  function listings(byPath: Record<string, string[]>) {
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      asked.push(`${url.pathname}?${path}`);
      const names = byPath[path] ?? [];
      return new Response(
        JSON.stringify({
          path,
          entries: names.map((name) => ({
            name,
            kind: name.includes(".") ? "file" : "directory",
            size: null,
            modifiedAt: null,
          })),
          truncated: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    return { fetcher, asked };
  }

  function fileProps(overrides: Overrides = {}) {
    const { fetcher } = listings({ "": ["src", "app.ts"], src: ["util.ts"] });
    return makeProps({
      scopeAreas: [scopeArea()],
      scopeNameById: new Map([["s1", "Now"]]),
      taskspaces: [taskspace("t1", "work", "s1")],
      taskspaceTree: new TaskspaceTreeState(),
      treeContext: { fetcher: fetcher as never, namespaceId: "p1" },
      onOpenFile: vi.fn(),
      ...overrides,
    });
  }

  function cellFor(container: HTMLElement, label: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`no cell labelled "${label}"`);
    return found;
  }

  it("reads a framed scope's taskspace without being asked, and draws what came back", async () => {
    const { container } = render(KozaneCanvas, fileProps());
    await settle();

    expect(container.querySelector("[data-scope-area-files='a1']")).not.toBeNull();
    expect(cellFor(container, "Open folder src")).toBeInTheDocument();
    expect(cellFor(container, "Open file app.ts")).toBeInTheDocument();
  });

  it("asks only for the taskspace root, not for the tree under it", async () => {
    const { fetcher, asked } = listings({ "": ["src", "app.ts"], src: ["util.ts"] });
    render(
      KozaneCanvas,
      fileProps({ treeContext: { fetcher: fetcher as never, namespaceId: "p1" } }),
    );
    await settle();

    expect(asked).toEqual(["/p1/api/taskspaces/t1/files?"]);
  });

  it("draws nothing under a frame whose scope has no taskspace", async () => {
    const { container } = render(KozaneCanvas, fileProps({ taskspaces: [] }));
    await settle();

    expect(container.querySelector("[data-scope-area-files='a1']")).toBeNull();
  });

  it("draws nothing under a frame whose taskspace belongs to another scope", async () => {
    const { container } = render(
      KozaneCanvas,
      fileProps({ taskspaces: [taskspace("t1", "work", "s2")] }),
    );
    await settle();

    expect(container.querySelector("[data-scope-area-files='a1']")).toBeNull();
  });

  it("asks once for a taskspace framed twice, and draws the icons under both frames", async () => {
    const { fetcher, asked } = listings({ "": ["app.ts"] });
    const { container } = render(
      KozaneCanvas,
      fileProps({
        scopeAreas: [scopeArea(), scopeArea({ id: "a2", posX: 1200 })],
        treeContext: { fetcher: fetcher as never, namespaceId: "p1" },
      }),
    );
    await settle();

    expect(asked).toEqual(["/p1/api/taskspaces/t1/files?"]);
    expect(container.querySelectorAll("[data-scope-area-files]")).toHaveLength(2);
  });

  it("hands a clicked file to the editor with the taskspace it belongs to", async () => {
    const onOpenFile = vi.fn();
    const { container } = render(KozaneCanvas, fileProps({ onOpenFile }));
    await settle();

    await fireEvent.click(cellFor(container, "Open file app.ts"));

    expect(onOpenFile).toHaveBeenCalledWith("t1", "app.ts");
  });

  it("drills into a folder, reading it and drawing what is in it", async () => {
    const { container } = render(KozaneCanvas, fileProps());
    await settle();

    await fireEvent.click(cellFor(container, "Open folder src"));
    await settle();

    expect(cellFor(container, "Open file util.ts")).toBeInTheDocument();
    expect(cellFor(container, "Leave src")).toBeInTheDocument();
    expect(container.querySelector("button[aria-label='Open file app.ts']")).toBeNull();
  });

  it("comes back out to the root it was drilled into from", async () => {
    const { container } = render(KozaneCanvas, fileProps());
    await settle();

    await fireEvent.click(cellFor(container, "Open folder src"));
    await settle();
    await fireEvent.click(cellFor(container, "Leave src"));
    await settle();

    expect(cellFor(container, "Open file app.ts")).toBeInTheDocument();
  });

  it("leaves another frame of the same scope where it was", async () => {
    const { container } = render(
      KozaneCanvas,
      fileProps({ scopeAreas: [scopeArea(), scopeArea({ id: "a2", posX: 1200 })] }),
    );
    await settle();

    const first = container.querySelector<HTMLElement>("[data-scope-area-files='a1']")!;
    await fireEvent.click(
      first.querySelector<HTMLElement>("button[aria-label='Open folder src']")!,
    );
    await settle();

    const second = container.querySelector<HTMLElement>("[data-scope-area-files='a2']")!;
    // Changing one frame leaves the scope's other frames unchanged.
    expect(first.textContent).toContain("util.ts");
    expect(second.textContent).toContain("app.ts");
    expect(second.textContent).not.toContain("util.ts");
  });

  it("follows the frame as it is dragged", async () => {
    // Use the harness so row mutations update the styles through parent-owned state.
    const { cards: initialCards, visibleCards: _v, zoom: _z, ...rest } = fileProps();
    const { container } = render(CanvasBindingHarness, { initialCards, ...rest });
    await settle();

    down(areaTabFor(container, "a1"), 100, 100);
    move(148, 148);
    up();
    await settle();

    // 248 + 480 + the gap that clears the resize handle.
    expect(container.querySelector<HTMLElement>("[data-scope-area-files='a1']")).toHaveStyle({
      left: "148px",
      top: `${248 + 480 + STRIP_GAP}px`,
    });
  });

  it("draws a file as inert on a board with no editor to open it in", async () => {
    const { container } = render(KozaneCanvas, fileProps({ onOpenFile: undefined }));
    await settle();

    expect(container.querySelector("button[aria-label='Open file app.ts']")).toBeNull();
    expect(container.querySelector("[data-scope-area-files='a1']")!.textContent).toContain(
      "app.ts",
    );
  });

  it("stops asking about a taskspace once it is gone", async () => {
    const { fetcher, asked } = listings({ "": ["app.ts"] });
    const props = fileProps({ treeContext: { fetcher: fetcher as never, namespaceId: "p1" } });
    const { container, rerender } = render(KozaneCanvas, props);
    await settle();

    await rerender({ ...props, taskspaces: [] });
    await settle();

    expect(asked).toEqual(["/p1/api/taskspaces/t1/files?"]);
    expect(container.querySelector("[data-scope-area-files='a1']")).toBeNull();
  });
});
