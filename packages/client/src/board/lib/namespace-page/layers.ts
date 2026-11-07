/** Layer order and stacking, and list reordering by drag or nudge. */
import { compareIds } from "@kozane/core";

export type StackedLayer<T> = { layer: T; rank: number; active: boolean; floating: boolean };

/**
 * Order layers bottom to top by position, then ID, matching `getAllLayers`. Derive other
 * layer views from this shared order.
 */
export function orderLayers<T extends { id: string; position: number }>(layers: T[]): T[] {
  // Use `compareIds` to match SQLite's binary ID ordering regardless of browser locale.
  return [...layers].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
}

/**
 * Stack ordinary layers in index order, then the active layer, then the dragged card's layer.
 * Draw active and dragged layers at full opacity.
 */
export function layerStack<T extends { id: string; position: number }>(
  layers: T[],
  activeLayerId: string | null,
  floatingLayerId: string | null = null,
): StackedLayer<T>[] {
  const priority = (layer: T) =>
    layer.id === floatingLayerId ? 2 : layer.id === activeLayerId ? 1 : 0;
  return orderLayers(layers)
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => priority(a.layer) - priority(b.layer) || a.index - b.index)
    .map(({ layer }, rank) => ({
      layer,
      rank,
      active: layer.id === activeLayerId,
      floating: layer.id === floatingLayerId,
    }));
}

/** Moves one id to `toIndex` within a list, closing the gap it leaves behind. */
export function moveWithin(ids: string[], id: string, toIndex: number): string[] {
  const next = [...ids];
  const from = next.indexOf(id);
  if (from === -1 || toIndex < 0 || toIndex >= next.length) return next;
  next.splice(from, 1);
  next.splice(toIndex, 0, id);
  return next;
}

/**
 * Reorder layers after a drop. Input and output use top-first display order, opposite to the
 * API's bottom-first order.
 */
export function reorderByDrop(ids: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return [...ids];
  return moveWithin(ids, draggedId, ids.indexOf(targetId));
}

/**
 * Move a layer up for `delta` -1 or down for 1 in display order. Return null when already at
 * the requested end.
 */
export function reorderByNudge(ids: string[], id: string, delta: -1 | 1): string[] | null {
  const target = ids.indexOf(id) + delta;
  if (target < 0 || target >= ids.length) return null;
  return moveWithin(ids, id, target);
}

/** One layer's cards as the canvas draws them, with its place in the stack. */
export type LayerGroup<C> = {
  id: string;
  rank: number;
  active: boolean;
  floating: boolean;
  cards: C[];
};

/**
 * Sort cards into their layers in stacking order. Without layer data, as in older exports,
 * draw one flat sheet. A card whose layer is missing from this namespace falls back to the
 * topmost layer rather than disappearing from the canvas.
 */
export function groupCardsByLayer<
  L extends { id: string; position: number },
  C extends { layerId: string },
>(
  layers: L[],
  activeLayerId: string | null,
  draggingLayerId: string | null,
  cards: C[],
): LayerGroup<C>[] {
  const stacked = layerStack(layers, activeLayerId, draggingLayerId);
  if (stacked.length === 0) return [{ id: "", rank: 0, active: true, floating: false, cards }];
  const groups = new Map(stacked.map(({ layer }) => [layer.id, [] as C[]]));
  const fallbackId = stacked[stacked.length - 1].layer.id;
  for (const card of cards) (groups.get(card.layerId) ?? groups.get(fallbackId)!).push(card);
  return stacked.map(({ layer, rank, active, floating }) => ({
    id: layer.id,
    rank,
    active,
    floating,
    cards: groups.get(layer.id)!,
  }));
}
