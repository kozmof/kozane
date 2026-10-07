import { compareIds } from "$lib/order";

/** Pure squarified treemap calculations shared by server and browser rendering. */

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** Something to be given area in proportion to `value`. */
export type TreemapItem = { id: string; value: number };

export type TreemapCell<T extends TreemapItem = TreemapItem> = {
  item: T;
  rect: Rect;
  /**
   * Whether a zero-value item was placed in the empty strip rather than given proportional
   * area.
   */
  empty: boolean;
};

/** Insets, in pixels, as a caller of {@link inset} names them. */
export type Insets = { top?: number; right?: number; bottom?: number; left?: number };

/** Inset `rect` on each side, clamping dimensions to zero when the insets exceed its size. */
export function inset(rect: Rect, by: Insets): Rect {
  const { top = 0, right = 0, bottom = 0, left = 0 } = by;
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  };
}

export const rectCenter = ({ x, y, width, height }: Rect): Point => ({
  x: x + width / 2,
  y: y + height / 2,
});

/**
 * Default empty-strip height and maximum height fraction. Allow callers to override height
 * for their content while preserving the fraction cap.
 */
const EMPTY_STRIP_HEIGHT = 18;
const EMPTY_STRIP_MAX_FRACTION = 0.25;

/** What {@link squarify} leaves to its caller. */
export type SquarifyOptions = {
  /** The empty strip's height in pixels, before the quarter-of-the-area cap. Defaults to 18,
   *  which is room for a dashed outline and nothing else. */
  emptyStripHeight?: number;
};

/**
 * Sort by descending value and then {@link compareIds} so equal-sized items produce
 * deterministic packing.
 */
function ordered<T extends TreemapItem>(items: T[]): T[] {
  return [...items].sort((a, b) => b.value - a.value || compareIds(a.id, b.id));
}

/** The worst aspect ratio in a row of areas laid along a side of length `side`. */
function worstRatio(areas: number[], side: number): number {
  if (areas.length === 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const area of areas) {
    sum += area;
    if (area > max) max = area;
    if (area < min) min = area;
  }
  // The published formula. `sum` is positive here because every area in a row comes from a
  // value the caller has already filtered to the positive ones.
  const scaled = side * side;
  return Math.max((scaled * max) / (sum * sum), (sum * sum) / (scaled * min));
}

/**
 * Lay a completed row along the remaining rectangle's shorter side and return the unused
 * area.
 */
function placeRow<T extends TreemapItem>(
  row: { item: T; area: number }[],
  remaining: Rect,
  cells: TreemapCell<T>[],
): Rect {
  const total = row.reduce((sum, { area }) => sum + area, 0);
  const horizontal = remaining.width >= remaining.height;
  // Handle zero-sized rectangles without dividing by a zero side.
  const side = horizontal ? remaining.height : remaining.width;
  const thickness = side > 0 ? total / side : 0;

  let offset = horizontal ? remaining.y : remaining.x;
  for (const { item, area } of row) {
    const length = thickness > 0 ? area / thickness : 0;
    cells.push({
      item,
      rect: horizontal
        ? { x: remaining.x, y: offset, width: thickness, height: length }
        : { x: offset, y: remaining.y, width: length, height: thickness },
      empty: false,
    });
    offset += length;
  }

  return horizontal
    ? { ...remaining, x: remaining.x + thickness, width: Math.max(0, remaining.width - thickness) }
    : {
        ...remaining,
        y: remaining.y + thickness,
        height: Math.max(0, remaining.height - thickness),
      };
}

/**
 * Build a squarified treemap using the algorithm of Bruls, Huizing, and van Wijk. Extend each
 * row while its worst aspect ratio improves, then place it along the shorter remaining side.
 *
 * Assign area in proportion to positive values. Keep zero-value items in a separate evenly
 * divided strip, capped at one quarter of the height when positive items exist. Use the full
 * rectangle for the strip when every value is zero.
 */
export function squarify<T extends TreemapItem>(
  items: T[],
  area: Rect,
  { emptyStripHeight = EMPTY_STRIP_HEIGHT }: SquarifyOptions = {},
): TreemapCell<T>[] {
  const cells: TreemapCell<T>[] = [];
  if (items.length === 0 || area.width <= 0 || area.height <= 0) return cells;

  const sorted = ordered(items);
  const positive = sorted.filter(({ value }) => value > 0);
  const zeros = sorted.filter(({ value }) => value <= 0);

  let packable = area;
  if (zeros.length > 0) {
    const height =
      positive.length === 0
        ? area.height
        : Math.min(emptyStripHeight, area.height * EMPTY_STRIP_MAX_FRACTION);
    const strip: Rect = { x: area.x, y: area.y + area.height - height, width: area.width, height };
    const width = strip.width / zeros.length;
    for (const [index, item] of zeros.entries()) {
      cells.push({ item, rect: { ...strip, x: strip.x + index * width, width }, empty: true });
    }
    packable = { ...area, height: Math.max(0, area.height - height) };
  }

  if (positive.length === 0 || packable.height <= 0) return cells;

  const total = positive.reduce((sum, { value }) => sum + value, 0);
  const scale = (packable.width * packable.height) / total;

  let remaining = packable;
  let row: { item: T; area: number }[] = [];
  for (const item of positive) {
    const scaled = item.value * scale;
    const side = Math.min(remaining.width, remaining.height);
    const areas = row.map(({ area: a }) => a);
    // Always accept the first item so each row is non-empty and layout makes progress.
    if (row.length === 0 || worstRatio([...areas, scaled], side) <= worstRatio(areas, side)) {
      row.push({ item, area: scaled });
    } else {
      remaining = placeRow(row, remaining, cells);
      row = [{ item, area: scaled }];
    }
  }
  if (row.length > 0) placeRow(row, remaining, cells);

  return cells;
}
