/**
 * Partition colors shared by browser and server readers. Keep this module independent of
 * route code so CLI compilation can import it.
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
 * Assign colors by position in the ID-ordered partition list. Repeat the palette when needed.
 * Adding a UUIDv7 partition preserves existing positions, while deleting one shifts later
 * colors.
 */
export function applyPalette<T extends { id: string }>(partitions: T[]) {
  return partitions.map((partition, i) => ({ ...partition, ...PALETTE[i % PALETTE.length] }));
}
