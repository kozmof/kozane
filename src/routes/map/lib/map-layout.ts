import { inset, rectCenter, squarify, type Rect, type Point } from "./treemap.js";
import { placeHubs, rectAnchor, scopeRail, curve, HUB_RADIUS } from "./graph.js";

/**
 * Compute map geometry from loader data and viewport size for both server and browser
 * rendering. Keep calculations independent of the DOM.
 */

/** The gap between one namespace's rectangle and the next, and between partitions inside one. */
const NAMESPACE_GAP = 6;
const PARTITION_GAP = 1.5;
/** The band along the top of a namespace's rectangle that carries its name. */
const NAMESPACE_TITLE_HEIGHT = 20;

/**
 * Minimum rectangle dimensions for a label. Omit labels below either threshold. Share these
 * limits with {@link NAMESPACE_EMPTY_STRIP_HEIGHT} so empty strips can fit their labels.
 */
export const LABEL_MIN_WIDTH = 54;
export const LABEL_MIN_HEIGHT = 20;

/**
 * Height of the empty-namespace strip. Include enough space for the label after gaps are
 * removed. Empty namespaces show their names without drawing nested empty partitions.
 */
const NAMESPACE_EMPTY_STRIP_HEIGHT = LABEL_MIN_HEIGHT + NAMESPACE_GAP;

/** Room left under the packing for the scope rail's spokes to travel through. */
const RAIL_CLEARANCE = 8;

export type LayoutPartition = {
  id: string;
  namespaceId: string;
  name: string;
  cards: number;
  bg: string;
  dot: string;
};

export type LayoutSpoke = { kind: "partition" | "namespace"; id: string; cards: number };
export type LayoutScope = { id: string; name: string; spokes: LayoutSpoke[] };

export type MapLayoutInput = {
  namespaces: { id: string; name: string }[];
  partitions: LayoutPartition[];
  scopes: LayoutScope[];
  /**
   * Rectangle in which to lay out the map, including pan and zoom. Returned geometry is
   * already in SVG coordinates.
   */
  area: Rect;
};

export type PlacedNamespace = {
  id: string;
  name: string;
  cards: number;
  rect: Rect;
  empty: boolean;
};
export type PlacedPartition = { partition: LayoutPartition; rect: Rect; empty: boolean };
/** A hub, where it sits, and one path per rectangle it reaches. */
export type PlacedScope = {
  id: string;
  name: string;
  point: Point;
  spokes: { id: string; kind: "partition" | "namespace"; cards: number; path: string }[];
};

export type MapLayout = {
  namespaces: PlacedNamespace[];
  partitions: PlacedPartition[];
  scopes: PlacedScope[];
  /** Where the rectangles end and the scope rail begins, so the page can rule a line there. */
  rail: Rect;
  /** Target rectangles keyed by ID for both namespaces and partitions. */
  rects: Map<string, Rect>;
};

const EMPTY_LAYOUT: MapLayout = {
  namespaces: [],
  partitions: [],
  scopes: [],
  rail: { x: 0, y: 0, width: 0, height: 0 },
  rects: new Map(),
};

/**
 * Reserve scope-rail space, pack the remaining area, then position hubs using the resulting
 * anchors. Size namespaces by total card count and keep zero-card namespaces in the empty
 * strip.
 */
export function buildMapLayout({
  namespaces,
  partitions,
  scopes,
  area,
}: MapLayoutInput): MapLayout {
  if (namespaces.length === 0 || area.width <= 0 || area.height <= 0) return EMPTY_LAYOUT;

  const rail = scopeRail(scopes.length, area);
  const packing =
    rail.height > 0 ? { ...area, height: Math.max(0, rail.y - area.y - RAIL_CLEARANCE) } : area;

  const byNamespace = new Map<string, LayoutPartition[]>();
  for (const partition of partitions) {
    const kept = byNamespace.get(partition.namespaceId) ?? [];
    kept.push(partition);
    byNamespace.set(partition.namespaceId, kept);
  }

  const placedNamespaces: PlacedNamespace[] = [];
  const placedPartitions: PlacedPartition[] = [];
  const rects = new Map<string, Rect>();

  const namespaceCells = squarify(
    namespaces.map(({ id, name }) => ({
      id,
      name,
      value: (byNamespace.get(id) ?? []).reduce((sum, { cards }) => sum + cards, 0),
    })),
    packing,
    { emptyStripHeight: NAMESPACE_EMPTY_STRIP_HEIGHT },
  );

  for (const cell of namespaceCells) {
    const rect = inset(cell.rect, {
      top: NAMESPACE_GAP / 2,
      right: NAMESPACE_GAP / 2,
      bottom: NAMESPACE_GAP / 2,
      left: NAMESPACE_GAP / 2,
    });
    placedNamespaces.push({
      id: cell.item.id,
      name: cell.item.name,
      cards: cell.item.value,
      rect,
      empty: cell.empty,
    });
    rects.set(cell.item.id, rect);

    // The title band is taken off the top before the partitions are packed, so a name never
    // sits over a rectangle it does not belong to.
    const inner = inset(rect, { top: NAMESPACE_TITLE_HEIGHT, right: 4, bottom: 4, left: 4 });
    for (const partitionCell of squarify(
      (byNamespace.get(cell.item.id) ?? []).map((partition) => ({
        ...partition,
        value: partition.cards,
      })),
      inner,
    )) {
      const partitionRect = inset(partitionCell.rect, {
        top: PARTITION_GAP / 2,
        right: PARTITION_GAP / 2,
        bottom: PARTITION_GAP / 2,
        left: PARTITION_GAP / 2,
      });
      placedPartitions.push({
        partition: partitionCell.item,
        rect: partitionRect,
        empty: partitionCell.empty,
      });
      rects.set(partitionCell.item.id, partitionRect);
    }
  }

  // Position hubs from rectangle centres. Border anchors already depend on hub positions and
  // would create a circular calculation.
  const hubs = placeHubs(
    scopes.map(({ id, spokes }) => ({
      id,
      toward: spokes.flatMap((spoke) => {
        const rect = rects.get(spoke.id);
        return rect ? [rectCenter(rect)] : [];
      }),
    })),
    rail,
  );
  const hubPoints = new Map(hubs.map(({ id, point }) => [id, point]));

  const placedScopes: PlacedScope[] = scopes.flatMap((scope) => {
    const point = hubPoints.get(scope.id);
    if (!point) return [];
    return [
      {
        id: scope.id,
        name: scope.name,
        point,
        spokes: scope.spokes.flatMap((spoke) => {
          const rect = rects.get(spoke.id);
          if (!rect) return [];
          return [{ ...spoke, path: curve(point, rectAnchor(rect, point)) }];
        }),
      },
    ];
  });

  return {
    namespaces: placedNamespaces,
    partitions: placedPartitions,
    scopes: placedScopes,
    rail,
    rects,
  };
}

/**
 * Draw the selected tag's links from its panel row to target partitions. Keep this separate
 * from packing so changing selection need not recompute the workspace layout.
 */
export function tagLinks(
  layout: MapLayout,
  from: Point,
  targets: Map<string, number>,
): { id: string; cards: number; path: string }[] {
  return [...targets]
    .flatMap(([id, cards]) => {
      const rect = layout.rects.get(id);
      return rect ? [{ id, cards, path: curve(from, rectAnchor(rect, from)) }] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export { HUB_RADIUS };
