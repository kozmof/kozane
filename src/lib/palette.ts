/**
 * The colours a partition is drawn in, and the rule that assigns them.
 *
 * Here rather than beside the board that draws them, though the board is the only thing that
 * *draws* a partition: three server-side readers have to answer with the same colours the board
 * would give, and one of them cannot reach a route module at all.
 *
 * `lib/server/treemap-snapshot.ts` was importing this from
 * `routes/[namespaceId]/lib/namespace-page.ts`, which pulled a route module — `$lib`/`$db`
 * aliases, `DOMRect` and all — into the program `tsconfig.cli.json` compiles, where neither
 * the aliases nor the DOM lib exist. That was not a style complaint: `pnpm build:cli` failed
 * on it, and with it `build`, `prepack` and `verify`. The colours are plain strings with no
 * dependency on anything, so the fix is for them to live where every layer may read them.
 *
 * Hues only, and no theme: a card's ground and its dot are the two values a partition carries,
 * and everything else about how one is drawn belongs to the board.
 */
export const PALETTE = [
  { bg: "oklch(93% 0.055 272)", dot: "oklch(80% 0.21 272)" },
  { bg: "oklch(93% 0.055 158)", dot: "oklch(80% 0.21 158)" },
  { bg: "oklch(93% 0.055 220)", dot: "oklch(80% 0.21 220)" },
  { bg: "oklch(93% 0.055 18)", dot: "oklch(80% 0.21 18)" },
  { bg: "oklch(93% 0.055 100)", dot: "oklch(80% 0.21 100)" },
  { bg: "oklch(93% 0.055 52)", dot: "oklch(80% 0.21 52)" },
  { bg: "oklch(93% 0.055 310)", dot: "oklch(80% 0.21 310)" },
  { bg: "oklch(93% 0.055 180)", dot: "oklch(80% 0.21 180)" },
] as const;

/**
 * A partition's colour is its place in the list its namespace's partitions come back in, so every
 * caller has to walk the same list in the same order — `getAllPartitions`, which orders by id —
 * or the map and the tag index would colour a partition differently from the board it belongs
 * to. Colours repeat once a namespace passes {@link PALETTE}`.length` (8), deliberately: a
 * ninth partition sharing the first one's colour is better than a ninth colour nobody chose.
 */
export function applyPalette<T extends { id: string }>(partitions: T[]) {
  return partitions.map((partition, i) => ({ ...partition, ...PALETTE[i % PALETTE.length] }));
}
