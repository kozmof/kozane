import { describe, expect, it } from "vitest";
import { dropTargetAt, sameDropTarget } from "./inventory-drop.js";

/** A document whose pointer stack is the given elements, topmost first. */
function docWith(stack: Element[]): Document {
  return { elementsFromPoint: () => stack } as unknown as Document;
}

function build(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("dropTargetAt", () => {
  const root = build(`
    <div data-canvas-surface><div id="card"></div><button id="icon" data-inventory-drop="i1"></button></div>
    <section id="window" data-inventory-drop="i2">
      <div id="cell" data-inventory-drop="i2" data-inventory-slot="7"></div>
      <div id="stored"></div>
    </section>`);
  const el = (id: string) => root.querySelector(`#${id}`)!;

  it("finds the cell under a stored card that lies over it", () => {
    expect(dropTargetAt(docWith([el("stored"), el("cell"), el("window")]), 0, 0)).toEqual({
      kind: "inventory",
      inventoryId: "i2",
      slot: 7,
    });
  });

  it("finds an icon under the canvas card being dragged over it", () => {
    expect(dropTargetAt(docWith([el("card"), el("icon")]), 0, 0)).toEqual({
      kind: "inventory",
      inventoryId: "i1",
      slot: null,
    });
  });

  it("falls back to the window, then the canvas, then nothing", () => {
    expect(dropTargetAt(docWith([el("window")]), 0, 0)).toEqual({
      kind: "inventory",
      inventoryId: "i2",
      slot: null,
    });
    expect(dropTargetAt(docWith([el("card")]), 0, 0)).toEqual({ kind: "canvas" });
    expect(dropTargetAt(docWith([]), 0, 0)).toBeNull();
  });
});

describe("sameDropTarget", () => {
  it("compares the place a target names", () => {
    const slot = { kind: "inventory" as const, inventoryId: "i", slot: 1 };
    expect(sameDropTarget(slot, { ...slot })).toBe(true);
    expect(sameDropTarget(slot, { ...slot, slot: 2 })).toBe(false);
    expect(sameDropTarget({ kind: "canvas" }, { kind: "canvas" })).toBe(true);
    expect(sameDropTarget(null, { kind: "canvas" })).toBe(false);
  });
});
