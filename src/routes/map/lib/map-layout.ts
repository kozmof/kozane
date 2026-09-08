import { inset, rectCenter, squarify, type Rect, type Point } from "./treemap.js";
import { placeHubs, rectAnchor, scopeRail, curve, HUB_RADIUS } from "./graph.js";

/**
 * Everything the map's `<svg>` draws, from the data the loader sent and the size of the box
 * it is being drawn into.
 *
 * One function, called twice per render: on the server against `MAP_DEFAULT_VIEWPORT`, and
 * in the browser against the box it measured. Keeping it here rather than in the component
 * is what makes the geometry testable without a DOM — and what keeps the server's HTML and
 * the browser's re-render the same map at two sizes rather than two maps.
 */

/** The gap between one namespace's rectangle and the next, and between partitions inside one. */
const NAMESPACE_GAP = 6;
const PARTITION_GAP = 1.5;
/** The band along the top of a namespace's rectangle that carries its name. */
const NAMESPACE_TITLE_HEIGHT = 20;

/**
 * The smallest rectangle a label is drawn in. Below either measure the rectangle is drawn
 * and left unlabelled, rather than carrying text wider or taller than itself.
 *
 * Here rather than in the component, though it is the component that does the drawing,
 * because {@link NAMESPACE_EMPTY_STRIP_HEIGHT} is computed from it: the strip has to be sized
 * so that what lands in it clears this, and a threshold the geometry cannot see is a
 * threshold the geometry sizes against by coincidence.
 */
export const LABEL_MIN_WIDTH = 54;
export const LABEL_MIN_HEIGHT = 20;

/**
 * How tall the strip of card-less *namespaces* along the bottom of the map is.
 *
 * Taller than the 18px `squarify` defaults to, and it has to be. That default is sized for a
 * partition, which is drawn in the strip as a dashed outline and nothing more; a namespace is a
 * rectangle that still has to say which namespace it is. {@link NAMESPACE_GAP} comes off it
 * before anything is drawn, so at the default an empty namespace reaches the page 12px tall —
 * under {@link LABEL_MIN_HEIGHT}, and so nameless. Two nameless boxes at the foot of the map
 * read as belonging to nothing, which is the opposite of what putting them there was for.
 *
 * So it is the sum rather than a number that happens to work: exactly the height at which a
 * namespace in the strip still carries its name, and it moves if either part moves.
 *
 * Its partitions are still not drawn — {@link NAMESPACE_TITLE_HEIGHT} plus the inner inset is
 * more than what is left. That is deliberate. A namespace in this strip has no cards anywhere
 * in it, so its partitions are empty by definition and would each be an outline inside an
 * outline; the named, empty rectangle already says the whole of what there is to say.
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
   * The rectangle to lay the packing into.
   *
   * The box on the page at rest, and something larger and offset once the view has been
   * zoomed or panned — see `lib/view.ts`. Everything this returns is therefore already in
   * the coordinates the `<svg>` draws in, and the page applies no transform of its own.
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
  /** Every rectangle a line can be drawn to, by id — partitions and namespaces alike. Kept so a
   *  caller drawing the tag graph does not walk the two lists to find one rectangle. */
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
 * The packing, the rail, and the graph over both.
 *
 * The order is forced and worth saying, because it is the one thing that could have been
 * circular: the rail's height depends on how many scopes there are and on nothing else, so it
 * can be reserved before the packing is laid out; the packing then fills what is left; and
 * only then do the hubs have anchors to sit under. Reserving the rail *after* packing would
 * mean packing twice.
 *
 * A namespace's area is the sum of its partitions' cards, so a namespace with cards in it is drawn
 * larger than one without — and a namespace with no cards at all lands in the empty strip
 * `squarify` keeps for exactly that, rather than being dropped from a map of the workspace.
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

  // Centres rather than anchors decide where a hub sits: an anchor is the point on a
  // rectangle's border facing the hub, so using them here would be asking where the hub is in
  // order to work out where the hub is.
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
 * The selected tag's lines: one from the point beside its row in the panel to each partition
 * that carries it.
 *
 * Apart from {@link buildMapLayout} because it is the one part of the drawing that changes
 * when nothing about the workspace has — clicking down the tree redraws these and leaves the
 * packing exactly as it was.
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
