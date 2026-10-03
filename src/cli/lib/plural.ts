/**
 * `1 card`, `2 cards` — the count and its noun, for the CLI's own output.
 *
 * Here because there were two copies, in `commands/doctor.ts` and `lib/db-json.ts`, and they
 * were the same line. Two places to decide what the plural of a noun is, kept in agreement by
 * nobody — the same argument `lib/lru.ts` makes about the four lines it gathered, on something
 * smaller and so easier to let drift.
 *
 * English `-s` only, which is all five nouns these callers pass need: card, name, row, problem,
 * namespace. A noun that pluralises some other way does not belong in an argument to this —
 * write it out at the call site rather than teaching this the exceptions.
 */
export function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}
