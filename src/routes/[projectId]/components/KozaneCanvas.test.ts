import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";
import KozaneCanvas from "./KozaneCanvas.svelte";
import { SelectionState } from "../project-state.svelte.js";
import { INACTIVE_LAYER_OPACITY, PALETTE } from "../lib/project-page.js";
import type { NewCardPlacement } from "$lib/ui-config";
import type { BundleWithColor, CardWithGlue, Layer, Warp } from "$lib/types";

/**
 * What this covers, and what it deliberately leaves to `project-page.test.ts`.
 *
 * The geometry and ordering this component draws with — `layerStack`, `clientToWorld`,
 * `rectsIntersect`, `dragGroupIds` — are pure functions tested on their own. What only
 * exists here is the composition: which card is rendered inside which layer wrapper, what
 * that wrapper's opacity and stacking come out as, and what a warp does that a card does
 * not. Those rules have no home outside the template, so they had no test at all.
 *
 * jsdom lays nothing out — every element has a zero-sized rect — so drag, marquee, and
 * edge-scroll are not assertable here and stay with `e2e/`.
 */

const color = (id: string): BundleWithColor => ({
  id,
  name: id,
  bg: PALETTE[0].bg,
  dot: PALETTE[0].dot,
  isDefault: false,
});

const layer = (id: string, position: number): Layer => ({
  id,
  projectId: "p1",
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
  bundleId: "b1",
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

const warp = (id: string): Warp => ({ id, projectId: "p1", posX: 100, posY: 100 });

type Overrides = Record<string, unknown>;

function makeProps(overrides: Overrides = {}) {
  const cards = [card("c1", "l1")];
  return {
    cards,
    visibleCards: cards,
    glueRels: [],
    layers: [layer("l1", 0)],
    activeLayerId: "l1",
    bundleColorById: new Map([["b1", color("b1")]]),
    selection: new SelectionState(),
    scopeCardIds: null,
    warps: [],
    focusedWarpId: null,
    warpsVisible: true,
    warpMarkerSize: 24,
    initialCenter: null,
    onFocusWarp: vi.fn(),
    showFooters: true,
    zoom: 1,
    zoomStep: 0.1,
    canvasWidth: 5600,
    canvasHeight: 4000,
    cardWidth: 240,
    newCardPlacement: "grid" as NewCardPlacement,
    fontSize: 11.5,
    fontFamily: "sans-serif",
    onPersistPositions: vi.fn(async () => true),
    onPersistWidth: vi.fn(async () => true),
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

  // A card whose layer this project no longer has must not vanish from the board: it is
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
  it("falls back to a single flat sheet when the project has no layers", () => {
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
