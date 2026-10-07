/**
 * Compare IDs without locale-dependent collation. Share the tie-breaker across CLI, browser,
 * and database operations so equal primary sort values produce consistent ordering.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
