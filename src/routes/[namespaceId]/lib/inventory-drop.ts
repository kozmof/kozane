/**
 * Where a drag would land if it let go here. Inventory icons and windows mark themselves with
 * `data-inventory-drop`, grid cells also with `data-inventory-slot`, and the board with
 * `data-canvas-surface`.
 *
 * Read from every element stacked under the pointer rather than the topmost one. The card
 * being dragged on the canvas is usually what sits directly under the pointer, and a stored
 * card covering several cells lies over the cells it covers.
 */
export type DropTarget =
  | { kind: "inventory"; inventoryId: string; slot: number | null }
  | { kind: "canvas" };

export function dropTargetAt(doc: Document, clientX: number, clientY: number): DropTarget | null {
  // jsdom has no `elementsFromPoint`. Tests that drop things stub it.
  const stack = doc.elementsFromPoint?.(clientX, clientY) ?? [];
  // A cell anywhere in the stack wins, so a drop on a stored card lands on the cell under it
  // rather than on its window as a whole.
  for (const el of stack) {
    const cell = el.closest<HTMLElement>("[data-inventory-slot]");
    const slot = Number(cell?.dataset.inventorySlot);
    if (cell?.dataset.inventoryDrop && Number.isInteger(slot) && slot >= 0)
      return { kind: "inventory", inventoryId: cell.dataset.inventoryDrop, slot };
  }
  let overCanvas = false;
  for (const el of stack) {
    const target = el.closest<HTMLElement>("[data-inventory-drop]");
    if (target)
      return { kind: "inventory", inventoryId: target.dataset.inventoryDrop ?? "", slot: null };
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
