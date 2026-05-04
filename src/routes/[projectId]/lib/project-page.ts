export const GRID = 24;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

export const PALETTE = [
  { bg: "oklch(93% 0.055 52)", dot: "oklch(62% 0.15 52)" },
  { bg: "oklch(93% 0.055 158)", dot: "oklch(62% 0.15 158)" },
  { bg: "oklch(93% 0.055 272)", dot: "oklch(62% 0.15 272)" },
  { bg: "oklch(93% 0.055 18)", dot: "oklch(62% 0.15 18)" },
  { bg: "oklch(93% 0.055 220)", dot: "oklch(62% 0.15 220)" },
  { bg: "oklch(93% 0.055 100)", dot: "oklch(62% 0.15 100)" },
  { bg: "oklch(93% 0.055 310)", dot: "oklch(62% 0.15 310)" },
  { bg: "oklch(93% 0.055 180)", dot: "oklch(62% 0.15 180)" },
] as const;

export function applyPalette<T extends { id: string }>(bundles: T[]) {
  return bundles.map((bundle, i) => ({ ...bundle, ...PALETTE[i % PALETTE.length] }));
}

export function glueIdByCardId<T extends { cardId: string; glueId: string }>(glueRels: T[]) {
  return new Map(glueRels.map((rel) => [rel.cardId, rel.glueId]));
}
