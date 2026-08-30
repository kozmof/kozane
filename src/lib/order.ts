/**
 * Ids compared the way SQLite's binary `ORDER BY id` compares them, rather than the way the
 * locale of the machine — or of the browser — running the comparison would.
 *
 * Every ordering in the app that has to separate two rows holding the same value breaks the
 * tie with this: {@link sortCards} on equal timestamps, `cardNearest` on equal distances,
 * `orderLayers` on equal positions, `reassignCardsToLayer` on equal `z_index`. It lives here
 * rather than beside any one of them because those three surfaces reach it from three
 * directions — the CLI orders rows SQLite handed over, the board orders rows that crossed
 * the wire, and `db/api` orders rows it is about to write back — and a tiebreak that
 * differed between them would show the same cards in a different order depending on which
 * one was asked.
 *
 * Not `localeCompare`: `"a".localeCompare("B")` is negative in every locale ICU knows, while
 * SQLite puts `"B"` first, an uppercase letter being the lower codepoint. The ids the app
 * writes are UUIDv7, on which the two agree; the ids an import, a fixture, or a hand-written
 * `INSERT` can put in the column are not, and an order that changes with `LANG` is not an
 * order worth promising.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
