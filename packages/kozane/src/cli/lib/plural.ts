/**
 * Format a count with an English noun that takes `-s`, such as `1 card` or `2 cards`. Handle
 * irregular plurals at the call site.
 */
export function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}
