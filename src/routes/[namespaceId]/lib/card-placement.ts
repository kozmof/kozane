import type { NewCardPlacement } from "$lib/ui-config";
import {
  GRID,
  verticalListPosition,
  type CardPosition,
  type PositionedCardSize,
} from "./namespace-page.js";

/** How far the board may scroll before a run of placements is treated as a new one. */
const PLACEMENT_SCROLL_EPSILON = 1;
/** How many cards a grid run puts in a row before starting the next. */
const GRID_COLUMNS = 4;

/** What the board looks like right now, as much of it as placement depends on. */
export type PlacementViewport = {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
};

export type PlacementRequest = {
  /**
   * Which card of the batch this is, as the caller counts them. Zero starts a fresh run —
   * `kozane card squash` in the browser adds several at once and wants them laid out
   * together, and a single card added on its own is a run of one.
   */
  seq: number;
  viewport: PlacementViewport;
  zoom: number;
  cardWidth: number;
  placement: NewCardPlacement;
  /**
   * The cards drawn at `at`, with the sizes they are actually drawn at — which only the DOM
   * knows, because a card's height depends on how its text wrapped.
   *
   * A callback rather than a list, so the measuring stays in the component and the sequencing
   * does not. It is asked for only on the vertical-list path, and only after the first card of
   * a run: the grid path computes its offsets and needs no measurement at all.
   */
  measureAt: (at: CardPosition) => PositionedCardSize[];
};

/**
 * Where the next new card goes, and the run of them it belongs to.
 *
 * Three fields of component state — `placementSeq`, `lastPlacementScroll`,
 * `lastListPosition` — and the rules relating them, which were readable only by reading
 * `getNewCardPosition` in `KozaneCanvas.svelte` from end to end. The rules are worth stating
 * on their own because they are about runs, not about any one card:
 *
 * - A run continues while the board has not been scrolled. Adding three cards in a row puts
 *   them beside or below each other rather than three in the same place.
 * - Scrolling ends a run. The board has been moved deliberately, so the next card starts
 *   again from the middle of wherever the view is now, rather than continuing a column the
 *   user has scrolled away from.
 * - `seq === 0` ends a run too, which is how the caller says "this is a new batch".
 *
 * The class keeps the run; the maths stays in `namespace-page.ts`, which is where
 * `verticalListPosition` already was. What moved out of the component is the state and the
 * three rules, which is the part a test could not reach before: the only way to assert that
 * scrolling restarts a run was to mount the board and scroll it.
 */
export class CardPlacement {
  #seq = 0;
  #lastScroll: { left: number; top: number } | null = null;
  #lastListPosition: CardPosition | null = null;

  /** Forgets the current run, so the next card starts one. */
  reset(): void {
    this.#seq = 0;
    this.#lastScroll = null;
    this.#lastListPosition = null;
  }

  next({ seq, viewport, zoom, cardWidth, placement, measureAt }: PlacementRequest): {
    posX: number;
    posY: number;
  } {
    const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
    if (seq === 0 || this.#viewportMoved(scroll)) {
      this.#seq = 0;
      this.#lastListPosition = null;
    }
    const layoutSeq = this.#seq++;
    this.#lastScroll = scroll;

    const { startX, startY } = this.#runOrigin(viewport, zoom, cardWidth);

    if (placement === "grid") {
      return {
        posX: startX + (layoutSeq % GRID_COLUMNS) * 6 * GRID,
        posY: startY + Math.floor(layoutSeq / GRID_COLUMNS) * 4 * GRID,
      };
    }

    // Below whatever is already in this column. The first card of a run has nothing to
    // measure against and nothing to measure — `measureAt` is not called for it.
    const previous = this.#lastListPosition;
    const sizes = previous ? measureAt(previous) : [];
    const position = verticalListPosition(sizes, startX, previous?.y ?? startY, cardWidth, 0);
    this.#lastListPosition = position;
    return { posX: position.x, posY: position.y };
  }

  /**
   * Whether the board has scrolled since the last placement, past the slack that makes a
   * single pixel of drift not count. Always false before the first placement of all: there
   * is no run yet for scrolling to have ended.
   */
  #viewportMoved(scroll: { left: number; top: number }): boolean {
    const last = this.#lastScroll;
    if (last === null) return false;
    return (
      Math.abs(scroll.left - last.left) > PLACEMENT_SCROLL_EPSILON ||
      Math.abs(scroll.top - last.top) > PLACEMENT_SCROLL_EPSILON
    );
  }

  /**
   * Where a run starts: the middle of the view, snapped to the grid, with the card's own
   * width taken off so that it is the card that is centred rather than its left edge.
   *
   * `startY` sits two grid steps above the centre line, which is what puts a single new card
   * in the middle of the view rather than with its top edge there.
   */
  #runOrigin(
    viewport: PlacementViewport,
    zoom: number,
    cardWidth: number,
  ): { startX: number; startY: number } {
    const centerX =
      Math.round((viewport.scrollLeft + viewport.clientWidth / 2) / zoom / GRID) * GRID;
    const centerY =
      Math.round((viewport.scrollTop + viewport.clientHeight / 2) / zoom / GRID) * GRID;
    return {
      startX: Math.max(0, Math.round((centerX - cardWidth / 2) / GRID) * GRID),
      startY: Math.max(0, centerY - 2 * GRID),
    };
  }
}
