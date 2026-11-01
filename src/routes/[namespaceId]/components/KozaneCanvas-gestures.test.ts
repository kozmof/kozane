import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";
import KozaneCanvas from "./KozaneCanvas.svelte";
import CanvasBindingHarness from "./CanvasBindingHarness.svelte";
import { SelectionState } from "../namespace-state.svelte.js";
import type { CardPositionPatch } from "../lib/namespace-page.js";
import { CARD_WIDTH_RANGE } from "$lib/ui-config";
import {
  card,
  warp,
  makeProps,
  down,
  move,
  up,
  settle,
  boundProps,
  cardEl,
  resizeHandle,
  type Overrides,
} from "./KozaneCanvas.fixtures.js";

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
