/** Chunk sizes for multi-row `CASE` updates, shared by position and stacking writes. */

import { BATCH_MAX, chunked } from "../../../lib/constants.js";

/**
 * Parameters required per row in a CASE update. Count the ID and value for each column, plus
 * the ID in the WHERE clause, so adding a column reduces the chunk size automatically.
 */
function caseUpdateParamsPerRow(columns: number): number {
  return 2 * columns + 1;
}

/**
 * Chunk CASE statements within the parameter limit. A shared transaction keeps the update
 * atomic.
 */
export function caseUpdateBatches<T>(rows: T[], columns: number): T[][] {
  return chunked(rows, { size: BATCH_MAX, columnsPerRow: caseUpdateParamsPerRow(columns) });
}
