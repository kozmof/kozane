import { compareIds } from "$lib/order";
import { tagMatcher } from "$lib/tag";
import type { TagHit } from "$lib/types";
import { MAP_TAG_LINKS_MAX } from "$lib/constants";
import type { Point, Rect } from "./treemap.js";

/**
 * Compute scope spokes and tag links over the treemap with shared pure geometry for server
 * and browser rendering.
 */

/** How large a scope's node is drawn, and the room one needs beside its label. */
export const HUB_RADIUS = 6;
const HUB_MIN_GAP = 120;

/** One row of the scope rail, and the breathing room above and below the rows. */
const RAIL_ROW_HEIGHT = 46;
const RAIL_PADDING = 14;
/**
 * Maximum space reserved for scope rows. Tighten row spacing when needed without consuming
 * the entire packing area.
 */
const RAIL_MAX_FRACTION = 0.4;

/**
 * Reserve a rail below the packing for scope hubs. Choose enough rows for the requested gap,
 * capped by {@link RAIL_MAX_FRACTION}. Reduce spacing when all hubs cannot fit at the
 * preferred gap.
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
  /** Anchors for this scope's links to target rectangles. */
  toward: Point[];
};

export type HubPlacement = { id: string; point: Point };

/**
 * Place hubs near the mean x of their targets. Distribute x-ordered hubs across rows, then
 * sweep in both directions to enforce spacing and bounds. Break ordering ties with {@link
 * compareIds} for deterministic layout.
 */
export function placeHubs(hubs: HubInput[], rail: Rect): HubPlacement[] {
  if (hubs.length === 0 || rail.height <= 0) return [];

  // Use the rail's actual reserved row count, which may be clamped to the available area.
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
      // Distribute hubs evenly when the rail cannot add rows and the preferred gaps do not
      // fit. Smaller gaps keep every hub inside the map.
      const step = span / (xs.length - 1);
      for (let i = 0; i < xs.length; i++) xs[i] = low + i * step;
    } else {
      for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + HUB_MIN_GAP);
      // Sweep backward from the right edge to bring overflowing hubs inside while preserving
      // the gap.
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
 * Find where the line toward `toward` meets the rectangle border so the visible spoke ends at
 * its target.
 */
export function rectAnchor(rect: Rect, toward: Point): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  // Use the nearer ray-edge crossing, ignoring edges parallel to the ray.
  const scaleX = dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Draw a quadratic Bézier curve bowed perpendicular to its endpoints. A fixed proportional
 * bow separates nearby spokes and keeps the path stable across renders without extra state.
 */
export function curve(from: Point, to: Point, bow = 0.14): string {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return `M ${from.x} ${from.y} Q ${mx - dy * bow} ${my + dx * bow} ${to.x} ${to.y}`;
}

/** Per-tag card counts by partition, bounded by `MAP_TAG_LINKS_MAX`. */
export type TagPartitionIndex = Record<string, Record<string, number> | undefined>;
export type MapTagCard = { namespaceId: string; partitionId: string; updatedDay: string };

/**
 * Exact written tags to partition counts, derived from the cached card dimensions the map
 * receives. Keeping card ids until this step lets a caller first filter hits by change day
 * while still counting a card only once when the same tag occurs on several lines.
 */
export function tagPartitionIndex(
  hits: TagHit[],
  cardData: Record<string, MapTagCard | undefined>,
): { index: TagPartitionIndex; truncated: boolean } {
  const cards = new Map<string, Map<string, Set<string>>>();
  let pairs = 0;
  let truncated = false;

  for (const hit of hits) {
    if (hit.source.kind !== "card") continue;
    const partitionId = cardData[hit.source.cardId]?.partitionId;
    if (!partitionId) continue;

    let byPartition = cards.get(hit.tag);
    if (!byPartition) cards.set(hit.tag, (byPartition = new Map()));
    let members = byPartition.get(partitionId);
    if (!members) {
      if (pairs >= MAP_TAG_LINKS_MAX) {
        truncated = true;
        continue;
      }
      pairs++;
      byPartition.set(partitionId, (members = new Set()));
    }
    members.add(hit.source.cardId);
  }

  const index: TagPartitionIndex = {};
  for (const [tag, byPartition] of cards) {
    const counts: Record<string, number> = {};
    for (const [partitionId, members] of byPartition) counts[partitionId] = members.size;
    index[tag] = counts;
  }
  return { index, truncated };
}

/**
 * Aggregate target weights for a tag and its descendants through {@link tagMatcher}.
 *
 * Weights can count one card more than once when it carries several matching tags. Use them
 * for link emphasis, not distinct-card labels. The tag tree computes distinct counts
 * separately.
 */
export function tagPartitionTargets(index: TagPartitionIndex, tag: string): Map<string, number> {
  const matches = tagMatcher(tag);
  const totals = new Map<string, number>();
  for (const [written, partitions] of Object.entries(index)) {
    if (!partitions || !matches(written)) continue;
    for (const [partitionId, cards] of Object.entries(partitions)) {
      totals.set(partitionId, (totals.get(partitionId) ?? 0) + cards);
    }
  }
  return totals;
}
