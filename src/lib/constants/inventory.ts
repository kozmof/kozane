/**
 * Inventory grid geometry. Slots are numbered left to right and top to bottom, so a slot
 * index and the column count are enough to place a card. The database stores only the index.
 */

/** Columns in every inventory grid. Rows grow as cards fill them. */
export const INVENTORY_COLUMNS = 6;

/** Rows an inventory shows even when it holds fewer cards, so there is room to drop into. */
export const INVENTORY_MIN_ROWS = 3;

/**
 * Highest slot index a writer accepts. Rows grow without a cap of their own, so this bounds
 * a request rather than the grid anyone would fill by hand.
 */
export const INVENTORY_SLOT_MAX = 9_999;
