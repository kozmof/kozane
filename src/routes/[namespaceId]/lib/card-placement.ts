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
  /** Card index within a placement batch. Zero starts a new run. */
  seq: number;
  viewport: PlacementViewport;
  zoom: number;
  cardWidth: number;
  placement: NewCardPlacement;
  /**
   * Measure rendered cards at `at` for vertical-list placement after the first card. Keep DOM
   * measurements in the caller because wrapped text determines card height.
   */
  measureAt: (at: CardPosition) => PositionedCardSize[];
};

/**
 * Track consecutive card placements. Continue a run while the viewport stays still, and start
 * a new run after scrolling or when `seq === 0`.
 *
 * Use the pure placement calculations in `namespace-page.ts` for grid and vertical-list
 * positions.
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

    // Place later cards below existing cards in the column. The first card needs no
    // measurement.
    const previous = this.#lastListPosition;
    const sizes = previous ? measureAt(previous) : [];
    const position = verticalListPosition(sizes, startX, previous?.y ?? startY, cardWidth, 0);
    this.#lastListPosition = position;
    return { posX: position.x, posY: position.y };
  }

  /**
   * Whether scrolling since the last placement exceeds the drift tolerance. False before the
   * first placement because there is no placement run to end.
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
   * Start a run at the grid-snapped view centre, offset by the card width to centre the card.
   * Place `startY` two grid steps above the centre line.
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
