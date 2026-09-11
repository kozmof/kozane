import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";
import KozaneCanvas from "./KozaneCanvas.svelte";
import CanvasBindingHarness from "./CanvasBindingHarness.svelte";
import { SelectionState } from "../namespace-state.svelte.js";
import { INACTIVE_LAYER_OPACITY } from "../lib/namespace-page.js";
import type { CardPositionPatch } from "../lib/namespace-page.js";
import { PALETTE } from "$lib/palette";
import type { NewCardPlacement } from "$lib/ui-config";
import type { PartitionWithColor, CardWithGlue, Layer, Warp } from "$lib/types";
import { CARD_WIDTH_RANGE } from "$lib/ui-config";

/**
 * What this covers, and what it deliberately leaves to `namespace-page.test.ts`.
 *
 * The geometry and ordering this component draws with — `layerStack`, `clientToWorld`,
 * `rectsIntersect`, `dragGroupIds` — are pure functions tested on their own. What only
 * exists here is the composition: which card is rendered inside which layer wrapper, what
 * that wrapper's opacity and stacking come out as, and what a warp does that a card does
 * not. Those rules have no home outside the template, so they had no test at all.
 *
 * jsdom lays nothing out — every element has a zero-sized rect — so the marquee, which
 * intersects card rects, and edge-scroll, which needs an element with edges, are not
 * assertable here and stay with `e2e/`. Dragging and resizing are, and are covered at the
 * foot of this file: see the note there for why the missing layout does not reach them.
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

  // A card whose layer this namespace no longer has must not vanish from the board: it is
  // drawn on the topmost layer rather than dropped on the floor. Topmost in *stacking*
  // order, which `layerStack` puts the active layer at — not the highest `position`.
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

  // The wrappers' z-index is what orders layers against each other; `card.zIndex` only ever
  // orders cards inside one of them. A card brought to the front of a dimmed layer does not
  // thereby cross in front of the layer being worked on.
  it("lifts the active layer above the rest, whatever zIndex its cards carry", () => {
    const cards = [card("c1", "l1", { zIndex: 0 }), card("c2", "l2", { zIndex: 99 })];
    const { container } = render(KozaneCanvas, {
      props: makeProps({
        cards,
        visibleCards: cards,
        layers: [layer("l1", 0), layer("l2", 1)],
        // Active is the *lower* layer by position, so a stack that merely followed
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

  // `visibleCards` is what the board filters; the canvas draws that and nothing else, so a
  // card filtered out of view is absent from the DOM rather than hidden in it.
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
 * Dragging and resizing, which is the state machine this component holds and the only part
 * of it with no pure function underneath.
 *
 * The header above says drag is not assertable here because jsdom lays nothing out. That is
 * true of anything measured against the viewport — the marquee, which intersects card rects,
 * and edge-scroll, which needs an element with edges — and it is not true of the drag
 * itself. The offset is taken from the same zero rect at mousedown that every move is
 * measured against, so the rect cancels: a pointer moved 60px right moves the card 60/zoom
 * canvas pixels, whatever `getBoundingClientRect` claims. What was untested here was not
 * untestable, and it is the code where a mistake is least visible — a drag that saves the
 * wrong position, or a failed save that leaves the board showing a move that did not happen.
 *
 * Written against the component rather than a lifted-out controller with a fake canvas: the
 * fake is where the bugs are not.
 */

const down = (target: Element, clientX: number, clientY: number, init: MouseEventInit = {}) =>
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button: 0, clientX, clientY, ...init }),
  );

const move = (clientX: number, clientY: number) =>
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));

const up = () => window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

/** A settled tick: the release awaits the persist callback before it rolls anything back. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The same props, split for {@link CanvasBindingHarness}: it owns `cards` and `zoom`, and
 * derives `visibleCards` from what it owns, so passing those through would give the canvas
 * two sources for one list.
 */
function boundProps(overrides: Overrides = {}) {
  const { cards, visibleCards: _visible, zoom: _zoom, ...props } = makeProps(overrides);
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

    // 10 + 60 and 20 + 40, each snapped to the nearest 24: 70 and 60 both land on 72.
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
    // The card does follow the pointer — the threshold gates the save and the snap, not the
    // drawing — so it is left the 2px off that nothing wrote down, until the next snapshot
    // poll puts it back.
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

    // The dragged card lands on the grid, and the rest of the group travels exactly the
    // distance it did — the snap on release moves the whole group, not just the card under
    // the pointer, so their spacing is what it was.
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
    // Still open while the save is in flight: a snapshot applied here would replace the
    // card list under the drag that produced it.
    expect(props.onPositionActivityEnd).not.toHaveBeenCalled();
    up();
    await settle();

    expect(props.onPositionActivityEnd).toHaveBeenCalledTimes(1);
  });

  // The rollback path. It has to put back the position the drag started from, not the one
  // the request carried — and it has to say so, since the card is already drawn moved.
  //
  // Through the harness, because the rollback replaces the whole array rather than writing
  // through the row: that assignment reaches a caller only across the binding, and the
  // canvas rendered on its own writes it to a plain object nobody reads.
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

    // 100 + 60 and 100 + 40, landing where the pointer did: a warp marks a point someone
    // chose, so nothing snaps it to the card grid on the way.
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

  // The marker is already drawn where it was dropped, so a refused save has to put it back
  // and say so. No harness here, unlike the card rollback: this writes through the row.
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

    // 240 + 60, snapped to the nearest 24 on release: 300 lands on 312.
    expect(props.cards[0].width).toBe(312);
    expect(props.onPersistWidth).toHaveBeenCalledWith("c1", 312);
  });

  // Out of range is refused rather than stored, on the server. Clamping here is what keeps
  // the board from ever asking: a drag past either end stops at it.
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
