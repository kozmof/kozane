/**
 * Where a drag would land if it let go here. Inventory icons and grids mark themselves with
 * `data-inventory-drop` (and grid cells also with `data-inventory-slot`), and the board with
 * `data-canvas-surface`.
 *
 * Read from the elements stacked under the pointer rather than the topmost one, because the
 * card being dragged on the canvas is usually what sits directly under the pointer.
 */
export type DropTarget =
  | { kind: "inventory"; inventoryId: string; slot: number | null }
  | { kind: "canvas" };

export function dropTargetAt(doc: Document, clientX: number, clientY: number): DropTarget | null {
  // jsdom has no `elementsFromPoint`. Tests that drop things stub it.
  const stack = doc.elementsFromPoint?.(clientX, clientY) ?? [];
  let overCanvas = false;
  for (const el of stack) {
    const target = el.closest<HTMLElement>("[data-inventory-drop]");
    if (target) {
      const slot = target.dataset.inventorySlot;
      return {
        kind: "inventory",
        inventoryId: target.dataset.inventoryDrop ?? "",
        slot: slot === undefined ? null : Number(slot),
      };
    }
    overCanvas ||= el.closest("[data-canvas-surface]") !== null;
  }
  return overCanvas ? { kind: "canvas" } : null;
}

/** Whether two targets name the same place, so a pointer move that stays put changes nothing. */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "canvas" || b.kind === "canvas") return a.kind === b.kind;
  return a.inventoryId === b.inventoryId && a.slot === b.slot;
}
