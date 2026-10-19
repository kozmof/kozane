/**
 * Inventory grid geometry. Slots are numbered left to right and top to bottom, so a slot
 * index and the column count are enough to place a card. The database stores only the index
 * of the card's top cell. How many cells it covers downward comes from its text.
 */

/** Columns in every inventory grid. Rows grow as cards fill them. */
export const INVENTORY_COLUMNS = 6;

/** Rows an inventory shows even when it holds fewer cards, so there is room to drop into. */
export const INVENTORY_MIN_ROWS = 3;

/**
 * Highest slot index a writer accepts, for any cell a card covers. Rows grow without a cap of
 * their own, so this bounds a request rather than the grid anyone would fill by hand.
 */
export const INVENTORY_SLOT_MAX = 9_999;

/**
 * How a grid cell is drawn, in CSS pixels. The server reads these too, because how many
 * cells a card covers is worked out from how much of its text fits in them.
 */
export const INVENTORY_CELL = {
  width: 104,
  height: 64,
  gap: 4,
  /** Inside the card's border, on each side. */
  paddingX: 6,
  paddingY: 5,
  fontSize: 10.5,
  lineHeight: 1.4,
} as const;

/**
 * The most rows one card covers. Longer text scrolls inside the card instead, so one card
 * cannot push the rest of the grid out of the window.
 */
export const INVENTORY_SPAN_MAX = 8;

/**
 * Tab stops on a stored card, in spaces. The card's CSS `tab-size` and the span estimate both
 * read this, so a tab is counted as wide as it is drawn.
 */
export const INVENTORY_TAB_SIZE = 8;
