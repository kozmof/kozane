/**
 * Inventory grid geometry. Slots are numbered left to right and top to bottom, so a slot
 * index and the column count are enough to place a card. The database stores only the index
 * of the card's top cell. Its text determines how many rows it covers.
 */

/** Columns in every inventory grid. Rows grow as cards fill them. */
export const INVENTORY_COLUMNS = 6;

/** Minimum visible rows, leaving room to drop cards into the inventory. */
export const INVENTORY_MIN_ROWS = 3;

/**
 * Highest slot index a writer accepts, for any cell a card covers. Rows grow without a cap of
 * their own, so this bounds a request rather than the grid anyone would fill by hand.
 */
export const INVENTORY_SLOT_MAX = 9_999;

/**
 * Grid cell dimensions in CSS pixels. The server uses the same values to estimate how many
 * rows a card's text needs.
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
