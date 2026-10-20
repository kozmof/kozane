/**
 * Identify the drop target under the pointer. Inventory icons and windows use
 * `data-inventory-drop`. Grid cells add `data-inventory-slot`, and the board uses
 * `data-canvas-surface`.
 *
 * Inspect the element stack to find targets beneath dragged cards and stored cards that
 * cover grid cells.
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
