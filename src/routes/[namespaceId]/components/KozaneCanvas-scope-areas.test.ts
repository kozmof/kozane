import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";
import KozaneCanvas from "../../../lib/client/board/components/KozaneCanvas.svelte";
import CanvasBindingHarness from "./CanvasBindingHarness.svelte";
import { SelectionState } from "../../../lib/client/board/namespace-state.svelte.js";
import type { CardPositionPatch } from "../../../lib/client/board/lib/namespace-page.js";
import { token } from "styled-system/tokens";
import {
  card,
  makeProps,
  down,
  move,
  up,
  settle,
  boundProps,
  cardEl,
  scopeArea,
  layOutFromStyle,
  layOut,
  areaTabFor,
  type Overrides,
} from "./KozaneCanvas.fixtures.js";

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
