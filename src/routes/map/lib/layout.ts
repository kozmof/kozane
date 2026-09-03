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

/** The gap between one project's rectangle and the next, and between bundles inside one. */
const PROJECT_GAP = 6;
const BUNDLE_GAP = 1.5;
/** The band along the top of a project's rectangle that carries its name. */
const PROJECT_TITLE_HEIGHT = 20;
/** Room left under the packing for the scope rail's spokes to travel through. */
const RAIL_CLEARANCE = 8;

export type LayoutBundle = {
  id: string;
  projectId: string;
  name: string;
  cards: number;
  bg: string;
  dot: string;
};

export type LayoutSpoke = { kind: "bundle" | "project"; id: string; cards: number };
export type LayoutScope = { id: string; name: string; spokes: LayoutSpoke[] };

export type MapLayoutInput = {
  projects: { id: string; name: string }[];
  bundles: LayoutBundle[];
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

export type PlacedProject = { id: string; name: string; cards: number; rect: Rect; empty: boolean };
export type PlacedBundle = { bundle: LayoutBundle; rect: Rect; empty: boolean };
/** A hub, where it sits, and one path per rectangle it reaches. */
export type PlacedScope = {
  id: string;
  name: string;
  point: Point;
  spokes: { id: string; kind: "bundle" | "project"; cards: number; path: string }[];
};

export type MapLayout = {
  projects: PlacedProject[];
  bundles: PlacedBundle[];
  scopes: PlacedScope[];
  /** Where the rectangles end and the scope rail begins, so the page can rule a line there. */
  rail: Rect;
  /** Every rectangle a line can be drawn to, by id — bundles and projects alike. Kept so a
   *  caller drawing the tag graph does not walk the two lists to find one rectangle. */
  rects: Map<string, Rect>;
};

const EMPTY_LAYOUT: MapLayout = {
  projects: [],
  bundles: [],
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
 * A project's area is the sum of its bundles' cards, so a project with cards in it is drawn
 * larger than one without — and a project with no cards at all lands in the empty strip
 * `squarify` keeps for exactly that, rather than being dropped from a map of the workspace.
 */
export function buildMapLayout({ projects, bundles, scopes, area }: MapLayoutInput): MapLayout {
  if (projects.length === 0 || area.width <= 0 || area.height <= 0) return EMPTY_LAYOUT;

  const rail = scopeRail(scopes.length, area);
  const packing =
    rail.height > 0 ? { ...area, height: Math.max(0, rail.y - area.y - RAIL_CLEARANCE) } : area;

  const byProject = new Map<string, LayoutBundle[]>();
  for (const bundle of bundles) {
    const kept = byProject.get(bundle.projectId) ?? [];
    kept.push(bundle);
    byProject.set(bundle.projectId, kept);
  }

  const placedProjects: PlacedProject[] = [];
  const placedBundles: PlacedBundle[] = [];
  const rects = new Map<string, Rect>();

  const projectCells = squarify(
    projects.map(({ id, name }) => ({
      id,
      name,
      value: (byProject.get(id) ?? []).reduce((sum, { cards }) => sum + cards, 0),
    })),
    packing,
  );

  for (const cell of projectCells) {
    const rect = inset(cell.rect, {
      top: PROJECT_GAP / 2,
      right: PROJECT_GAP / 2,
      bottom: PROJECT_GAP / 2,
      left: PROJECT_GAP / 2,
    });
    placedProjects.push({
      id: cell.item.id,
      name: cell.item.name,
      cards: cell.item.value,
      rect,
      empty: cell.empty,
    });
    rects.set(cell.item.id, rect);

    // The title band is taken off the top before the bundles are packed, so a name never
    // sits over a rectangle it does not belong to.
    const inner = inset(rect, { top: PROJECT_TITLE_HEIGHT, right: 4, bottom: 4, left: 4 });
    for (const bundleCell of squarify(
      (byProject.get(cell.item.id) ?? []).map((bundle) => ({
        ...bundle,
        value: bundle.cards,
      })),
      inner,
    )) {
      const bundleRect = inset(bundleCell.rect, {
        top: BUNDLE_GAP / 2,
        right: BUNDLE_GAP / 2,
        bottom: BUNDLE_GAP / 2,
        left: BUNDLE_GAP / 2,
      });
      placedBundles.push({ bundle: bundleCell.item, rect: bundleRect, empty: bundleCell.empty });
      rects.set(bundleCell.item.id, bundleRect);
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
    projects: placedProjects,
    bundles: placedBundles,
    scopes: placedScopes,
    rail,
    rects,
  };
}

/**
 * The selected tag's lines: one from the point beside its row in the panel to each bundle
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
