import { compareIds } from "$lib/order";
import { tagMatcher } from "$lib/tag";
import type { Point, Rect } from "./treemap.js";

/**
 * The lines drawn over the map's packing: a scope's spokes to the bundles it reaches, and the
 * selected tag's links to the bundles that carry it.
 *
 * Pure, for the reason `treemap.ts` is — the server and the browser both lay this out, and a
 * hub that landed somewhere different between the two would jump on hydration.
 */

/** How large a scope's node is drawn, and the room one needs beside its label. */
export const HUB_RADIUS = 6;
const HUB_MIN_GAP = 120;

/** One row of the scope rail, and the breathing room above and below the rows. */
const RAIL_ROW_HEIGHT = 46;
const RAIL_PADDING = 14;
/**
 * The most of the map a rail of scopes may take. A workspace with more scopes than the rail
 * can hold rows for keeps the rows it can and packs them tighter, rather than squeezing the
 * packing — which is the thing the page is actually about — down to a band.
 */
const RAIL_MAX_FRACTION = 0.4;

/**
 * A packing fills its rectangle completely, so there is no gap in it for a scope's node to
 * sit in. The map reserves a band below the packing instead and draws every hub there, which
 * is also what makes the spokes read as a graph *over* the treemap rather than as marks
 * inside one of its cells.
 *
 * How many rows that band needs: as many as it takes to give each hub {@link HUB_MIN_GAP} of
 * width, capped so the band never takes more than {@link RAIL_MAX_FRACTION} of the map. A
 * workspace past that cap draws its hubs closer together than the gap asks for — the
 * alternative is a rail taller than the map it annotates.
 */
export function scopeRailRows(count: number, area: Rect): number {
  if (count === 0) return 0;
  const capacity = Math.max(1, Math.floor(area.width / HUB_MIN_GAP));
  const wanted = Math.ceil(count / capacity);
  const affordable = Math.max(
    1,
    Math.floor((area.height * RAIL_MAX_FRACTION - 2 * RAIL_PADDING) / RAIL_ROW_HEIGHT),
  );
  return Math.min(wanted, affordable);
}

/** The band those rows occupy, along the bottom of `area`. Zero-height when there are no
 *  scopes, so a workspace without any gives the whole map to the packing. */
export function scopeRail(count: number, area: Rect): Rect {
  const rows = scopeRailRows(count, area);
  if (rows === 0) return { x: area.x, y: area.y + area.height, width: area.width, height: 0 };
  const height = Math.min(area.height, rows * RAIL_ROW_HEIGHT + 2 * RAIL_PADDING);
  return { x: area.x, y: area.y + area.height - height, width: area.width, height };
}

export type HubInput = {
  id: string;
  /** Where this scope's spokes are going — the anchors on the bundles it reaches. */
  toward: Point[];
};

export type HubPlacement = { id: string; point: Point };

/**
 * Where each scope's node sits in the rail.
 *
 * Under the middle of what it reaches, so a spoke is as short and as vertical as the rail
 * allows: a hub starts at the mean x of its own anchors. Two scopes over the same bundles
 * would then sit on top of each other, so the row is swept left to right pushing each hub to
 * at least {@link HUB_MIN_GAP} past the one before it, and then right to left to bring back
 * anything the first sweep pushed off the end.
 *
 * Hubs are dealt across the rows rather than chunked into them — sorted by x, then row
 * `index % rows`. Chunking would put every hub of the left-hand projects in the top row and
 * leave the bottom row under the right-hand ones, which is the crossing pattern the rows were
 * added to avoid; dealing gives every row the full width to spread over.
 *
 * Deterministic throughout: the sort breaks its ties with {@link compareIds}, and both sweeps
 * are single passes over a fixed order.
 */
export function placeHubs(hubs: HubInput[], rail: Rect): HubPlacement[] {
  if (hubs.length === 0 || rail.height <= 0) return [];

  // Read back off the rail rather than recomputed from the map, because the rail is what
  // was actually reserved: `scopeRail` may have clamped its rows against the area, and
  // laying out more rows than the band holds would draw hubs below it.
  const rows = Math.max(1, Math.round((rail.height - 2 * RAIL_PADDING) / RAIL_ROW_HEIGHT));
  const rowHeight = (rail.height - 2 * RAIL_PADDING) / rows;
  const center = rail.x + rail.width / 2;

  const wanted = hubs
    .map(({ id, toward }) => ({
      id,
      x: toward.length === 0 ? center : toward.reduce((sum, p) => sum + p.x, 0) / toward.length,
    }))
    .sort((a, b) => a.x - b.x || compareIds(a.id, b.id));

  const placed: HubPlacement[] = [];
  for (let row = 0; row < rows; row++) {
    const inRow = wanted.filter((_, index) => index % rows === row);
    const low = rail.x + HUB_MIN_GAP / 2;
    const high = rail.x + rail.width - HUB_MIN_GAP / 2;
    const xs = inRow.map(({ x }) => Math.min(Math.max(x, low), high));

    const span = high - low;
    if (xs.length > 1 && (xs.length - 1) * HUB_MIN_GAP > span) {
      // More hubs than this row has gaps for, which happens only once `scopeRail` has hit
      // its own ceiling and stopped adding rows. Spread them evenly across the row rather
      // than sweeping: a sweep would honour the gap for the first of them and push the rest
      // off the end of the map. Tighter than the gap asks for is the concession the ceiling
      // already decided to make.
      const step = span / (xs.length - 1);
      for (let i = 0; i < xs.length; i++) xs[i] = low + i * step;
    } else {
      for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + HUB_MIN_GAP);
      // The forward sweep only ever pushes right, so a row crowded against the right-hand
      // edge ends past it. Pin the last hub back on the edge and let the same gap propagate
      // leftwards; the row fits, so this cannot push the first one off the other end.
      const last = xs.length - 1;
      if (last >= 0 && xs[last] > high) {
        xs[last] = high;
        for (let i = last - 1; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - HUB_MIN_GAP);
      }
    }

    const y = rail.y + RAIL_PADDING + row * rowHeight + rowHeight / 2;
    for (const [i, hub] of inRow.entries()) placed.push({ id: hub.id, point: { x: xs[i], y } });
  }

  return placed;
}

/**
 * Where a line from `toward` meets the border of `rect`.
 *
 * A spoke drawn to a rectangle's centre disappears under the rectangle, which on a packing —
 * where the rectangles are the whole picture — means the line is only visible outside the
 * thing it points at. Stopping it on the border is what makes it point.
 */
export function rectAnchor(rect: Rect, toward: Point): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // How far along the ray the first edge is met: the smaller of the two crossings, each
  // ignored where the ray is parallel to that pair of edges.
  const scaleX = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * A quadratic bezier from one point to the other, bowed perpendicular to the line between
 * them.
 *
 * Curved rather than straight, and the reason is legibility rather than decoration: several
 * spokes from one hub to bundles in a row of one project are near-parallel straight lines
 * that overlap for most of their length, while a bow proportional to the distance separates
 * them. The bow is a fixed fraction, so the path is a function of its endpoints alone and
 * needs no state to stay put between renders.
 */
export function curve(from: Point, to: Point, bow = 0.14): string {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return `M ${from.x} ${from.y} Q ${mx - dy * bow} ${my + dx * bow} ${to.x} ${to.y}`;
}

/**
 * Cards per bundle, per tag exactly as written. The shape the map loader sends and the only
 * thing the tag graph is drawn from — see `MAP_TAG_LINKS_MAX`.
 */
export type TagBundleIndex = Record<string, Record<string, number> | undefined>;

/**
 * The bundles a tag reaches, each with the weight of the line to draw to it.
 *
 * Rolled up over subcategories with {@link tagMatcher}, so `'perf` reaches everything
 * `'perf:cache` and `'perf:cache:invalidation` reach — the same rule the tag index, the CLI
 * and the card renderer use, reached for rather than restated. That is why the index is
 * keyed by the exact tag: rolling up here costs one pass over the keys and keeps one entry
 * per tag in what crosses the wire, where pre-rolling would store every tag's cards again
 * under each of its ancestors.
 *
 * **A weight, and not a count of cards.** One card carrying both `'perf:cache` and
 * `'perf:disk` is two entries under `'perf`, and summing them counts it twice — which is
 * why `buildTagTree` tallies sets of sources rather than adding numbers. Distinguishing
 * them here would mean shipping the card ids the aggregate exists to avoid shipping, and the
 * line does not need it: what it decides is which bundles are linked and how heavily. The
 * true count is in the tree beside it, where it is exact, and the page draws this as a line
 * rather than printing it as a number.
 */
export function tagBundleTargets(index: TagBundleIndex, tag: string): Map<string, number> {
  const matches = tagMatcher(tag);
  const totals = new Map<string, number>();
  for (const [written, bundles] of Object.entries(index)) {
    if (!bundles || !matches(written)) continue;
    for (const [bundleId, cards] of Object.entries(bundles)) {
      totals.set(bundleId, (totals.get(bundleId) ?? 0) + cards);
    }
  }
  return totals;
}
