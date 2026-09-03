import { compareIds } from "$lib/order";

/**
 * The packing the map page is drawn from: a squarified treemap, and the two decisions the
 * published algorithm leaves open.
 *
 * Pure arithmetic, deliberately — no DOM, no stores, no `$state`. The layout is computed
 * twice for every render of the page: once on the server, which has no browser to measure,
 * and again in the browser once it has measured its own container. Both call this, so the
 * served HTML and the hydrated page differ in the size they were packed at and in nothing
 * else. See `MAP_DEFAULT_VIEWPORT`.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** Something to be given area in proportion to `value`. */
export type TreemapItem = { id: string; value: number };

export type TreemapCell<T extends TreemapItem = TreemapItem> = {
  item: T;
  rect: Rect;
  /**
   * Whether this cell was laid into the empty strip rather than given proportional area.
   * True exactly when `item.value` is zero — see {@link squarify}. Carried on the cell so a
   * caller draws the two differently without re-deriving which is which from the value it
   * has already been given.
   */
  empty: boolean;
};

/** Insets, in pixels, as a caller of {@link inset} names them. */
export type Insets = { top?: number; right?: number; bottom?: number; left?: number };

/** `rect` pulled in on each side, never past nothing: a rectangle smaller than its own
 *  insets collapses to zero rather than turning inside out. */
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
 * How tall the strip along the bottom of a rectangle is when something has to go in it, and
 * how much of the rectangle it may take. A strip is for the items that have no area to be
 * given; it must be tall enough to be seen and small enough that a workspace of mostly empty
 * bundles does not turn the map into a row of them.
 *
 * The height is what a caller may override, because "tall enough to be seen" is a question
 * about what is going in the strip rather than about the packing. A bundle laid there is a
 * dashed outline, and 18px is room for one; a *project* laid there is a rectangle that still
 * has to carry its own name, and needs more — see `PROJECT_EMPTY_STRIP_HEIGHT` in
 * `map-layout.ts`. The fraction is deliberately not overridable: it is the promise that the strip
 * stays a footnote, and it holds against whatever height a caller asks for.
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
 * Descending by value, with {@link compareIds} as the tiebreak.
 *
 * The tiebreak is the point. Squarifying is order-dependent, so two bundles holding the same
 * number of cards decide which of them the algorithm reaches first — and if that came out of
 * SQLite's row order, the same workspace could pack differently between the server's render
 * and the browser's, and the map would visibly rearrange itself on hydration. `compareIds` is
 * the tiebreak `orderLayers` and `sortCards` already use, so this is the app's one answer to
 * "equal, now what" rather than a second one.
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
 * Lay one finished row along the shorter side of `remaining`, and answer with what is left.
 *
 * The row runs down the left edge when the rectangle is wider than tall, and along the top
 * edge when it is taller than wide — which is what keeps the cells square-ish, since the
 * algorithm only ever commits a row when adding to it would make its worst cell worse.
 */
function placeRow<T extends TreemapItem>(
  row: { item: T; area: number }[],
  remaining: Rect,
  cells: TreemapCell<T>[],
): Rect {
  const total = row.reduce((sum, { area }) => sum + area, 0);
  const horizontal = remaining.width >= remaining.height;
  // Guarded against a zero side, which arises when a caller hands in a rectangle with no
  // width or height at all; the cells are then all zero-sized and nothing divides by it.
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
 * The squarified treemap of Bruls, Huizing and van Wijk: items are laid into the shorter side
 * of what is left, a row growing for as long as adding to it improves the worst aspect ratio
 * in it, and committed the moment it would not.
 *
 * Area is proportional to value, which is the one thing a treemap promises and the reason for
 * the two rules below.
 *
 * **Order is fixed** — see {@link ordered}.
 *
 * **Zero has no area.** A bundle holding no cards cannot be given a rectangle in proportion
 * to nothing, and the two obvious ways out are both wrong on a page whose subject is what a
 * workspace holds: dropping it makes an empty bundle invisible rather than empty, and
 * packing `value + 1` distorts every other rectangle to give it something to show. So the
 * zero-valued items are laid into a strip along the bottom instead, split evenly, and marked
 * `empty` so the page can draw them as the outlines they are. The strip is capped at a
 * quarter of the height: a workspace of a hundred empty bundles and two full ones is still a
 * map of the two full ones.
 *
 * A rectangle with nothing positive in it is *all* strip, which is the same rule read from
 * the other end — a project whose every bundle is empty is drawn as those bundles, not as a
 * blank.
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
    // The first item of a row always goes in: a row of one has a worst ratio to beat, and
    // committing an empty row would loop forever.
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
