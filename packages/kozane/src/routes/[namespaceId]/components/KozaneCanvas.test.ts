import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import { BoardCanvas as KozaneCanvas } from "@kozane/client/board";
import { SelectionState } from "../../../../../client/src/board/namespace-state.svelte.js";
import { INACTIVE_LAYER_OPACITY } from "../../../../../client/src/board/lib/namespace-page.js";
import {
  layer,
  card,
  warp,
  makeProps,
  layerWrappers,
  wrapperFor,
  cardIdsIn,
} from "./KozaneCanvas.fixtures.js";

/**
 * Test canvas composition, layer rendering, warp behavior, and gesture wiring. Pure geometry
 * helpers have separate tests. Use browser tests for layout-dependent marquee and edge-scroll
 * behavior.
 */

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
