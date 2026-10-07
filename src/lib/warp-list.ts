import type { Warp } from "./types.js";
import { WARP_HINT_MAX_CHARS } from "./constants.js";

/**
 * Cross-namespace warp palette row. Number warps within each namespace to match their board
 * labels.
 */
export type WarpListEntry = {
  id: string;
  namespaceId: string;
  namespaceName: string;
  label: number;
  posX: number;
  posY: number;
  /** Text of the card nearest the warp, or null when nothing is close enough. */
  hint: string | null;
  isCurrent: boolean;
};

/**
 * Positioned card data used for warp hints. Content can be a prefix when `contentChars`
 * carries the full length.
 */
export type HintCard = {
  posX: number;
  posY: number;
  content: string;
  /**
   * How many characters the whole card holds, when `content` is only its opening. Omitted
   * when `content` is the whole of it, which is the case on the board being viewed.
   */
  contentChars?: number;
  zIndex?: number;
  /**
   * Pinned card width, or null/omitted to use the workspace default. Use it for both
   * horizontal bounds and estimated text wrapping.
   */
  width?: number | null;
};

/** What every card on a board is drawn at, which is what turns a position into a box. */
export type CardMetrics = { cardWidth: number; fontSize: number };

/** Convert workspace UI settings to the metric names used by hint calculations. */
export function cardMetrics(ui: {
  defaultCardWidth: number;
  defaultFontSize: number;
}): CardMetrics {
  return { cardWidth: ui.defaultCardWidth, fontSize: ui.defaultFontSize };
}

/**
 * Maximum distance in world pixels from a warp to a card's edge for that card to describe the
 * warp. Use two card widths to exclude distant cards.
 */
export const WARP_HINT_RADIUS = 480;

/**
 * Card dimensions mirrored from KozaneCard.svelte, including vertical padding, reserved
 * footer space, and minimum content height. Panda requires literal styles in the component.
 * Export these values so tests can verify that they match those styles.
 */
export const CARD_BOX = {
  /** Left plus right padding. */
  paddingX: 20,
  /** Top plus bottom padding. */
  paddingY: 16,
  /** Estimate footer height. Other measurements match component constants. */
  footerHeight: 24,
  minContentHeight: 44,
  lineHeightRatio: 1.65,
} as const;
/**
 * Width of one narrow character cell relative to the font size, for the monospace the
 * cards default to.
 */
const CHAR_WIDTH_RATIO = 0.6;

/**
 * Code point ranges treated as double-width for monospace estimates, including CJK, Hangul,
 * fullwidth forms, and emoji.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo, Kanbun
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji
  [0x1f900, 0x1f9ff], // Supplemental symbols and pictographs
  [0x20000, 0x3fffd], // CJK Unified Ideographs Extension B and beyond
];

/** How wide one code point is drawn, in narrow cells. */
function charCells(codePoint: number): number {
  return WIDE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi) ? 2 : 1;
}

/**
 * How many cells a line of text takes up. Counted by code point, so a character outside
 * the basic plane counts once rather than once per surrogate half.
 */
export function textCells(text: string): number {
  let cells = 0;
  for (const char of text) cells += charCells(char.codePointAt(0)!);
  return cells;
}

/**
 * Estimate rendered card height from text and width because the database stores no measured
 * height.
 */
export function estimateCardHeight(content: string, { cardWidth, fontSize }: CardMetrics): number {
  const cellsPerLine = Math.max(
    1,
    Math.floor((cardWidth - CARD_BOX.paddingX) / (fontSize * CHAR_WIDTH_RATIO)),
  );
  const lines = content
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(textCells(line) / cellsPerLine)), 0);
  const textHeight = lines * fontSize * CARD_BOX.lineHeightRatio + CARD_BOX.paddingY;
  return Math.max(CARD_BOX.minContentHeight, textHeight) + CARD_BOX.footerHeight;
}

/** Rendered card width, using its pinned width or the configured default. */
function hintCardWidth(card: HintCard, metrics: CardMetrics): number {
  return card.width ?? metrics.cardWidth;
}

/**
 * Estimate hint-card height at its pinned or default width. For truncated content, scale the
 * prefix measurement by full text length, assuming the prefix represents the rest.
 */
function hintCardHeight(card: HintCard, metrics: CardMetrics): number {
  const measured = estimateCardHeight(card.content, {
    cardWidth: hintCardWidth(card, metrics),
    fontSize: metrics.fontSize,
  });
  const sampled = [...card.content].length;
  if (card.contentChars === undefined || sampled === 0) return measured;
  return measured * Math.max(1, card.contentChars / sampled);
}

/**
 * Squared distance from a point to a card's box, or zero inside it. Squaring preserves
 * distance order without a square root.
 */
function squaredDistanceToCard(
  point: { posX: number; posY: number },
  card: HintCard,
  metrics: CardMetrics,
): number {
  const dx = Math.max(
    card.posX - point.posX,
    0,
    point.posX - (card.posX + hintCardWidth(card, metrics)),
  );
  const dy = Math.max(
    card.posY - point.posY,
    0,
    point.posY - (card.posY + hintCardHeight(card, metrics)),
  );
  return dx * dx + dy * dy;
}

function condense(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length > WARP_HINT_MAX_CHARS
    ? `${oneLine.slice(0, WARP_HINT_MAX_CHARS - 1).trimEnd()}…`
    : oneLine;
}

/**
 * Build a short hint from the card nearest the warp's point. Measure distance to estimated
 * card boxes so a containing card has zero distance.
 */
export function nearestCardHint(
  warp: { posX: number; posY: number },
  cards: readonly HintCard[],
  metrics: CardMetrics,
): string | null {
  const limit = WARP_HINT_RADIUS * WARP_HINT_RADIUS;
  let best: HintCard | null = null;
  let bestDistance = Infinity;
  let bestZIndex = -Infinity;
  for (const card of cards) {
    if (card.content.trim() === "") continue;
    const distance = squaredDistanceToCard(warp, card, metrics);
    if (distance > limit) continue;
    const zIndex = card.zIndex ?? 0;
    // Prefer smaller distance, then higher stacking for overlapping cards. Preserve input
    // order for exact ties.
    if (distance > bestDistance || (distance === bestDistance && zIndex <= bestZIndex)) continue;
    best = card;
    bestDistance = distance;
    bestZIndex = zIndex;
  }
  return best ? condense(best.content) : null;
}

type WarpEntriesForNamespace = {
  namespace: { id: string; name: string };
  /** Creation order from `getAllWarps`, matching marker numbers. */
  warps: readonly Warp[];
  cards: readonly HintCard[];
  metrics: CardMetrics;
  isCurrent: boolean;
};

export function warpEntriesForNamespace({
  namespace,
  warps,
  cards,
  metrics,
  isCurrent,
}: WarpEntriesForNamespace): WarpListEntry[] {
  return warps.map((warp, index) => ({
    id: warp.id,
    namespaceId: namespace.id,
    namespaceName: namespace.name,
    label: index + 1,
    posX: warp.posX,
    posY: warp.posY,
    hint: nearestCardHint(warp, cards, metrics),
    isCurrent,
  }));
}

/**
 * The entry `delta` steps from `id`, wrapping at both ends so the highlight cycles rather
 * than sticking. Falls to the first entry when nothing is highlighted yet.
 */
export function moveHighlight(
  entries: readonly WarpListEntry[],
  id: string | null,
  delta: -1 | 1,
): WarpListEntry | null {
  if (entries.length === 0) return null;
  const current = entries.findIndex((entry) => entry.id === id);
  if (current === -1) return entries[delta === 1 ? 0 : entries.length - 1];
  return entries[(current + delta + entries.length) % entries.length];
}

/**
 * Remove `warpId` and renumber its namespace to match the board markers. Namespace entries
 * are contiguous, so one counter suffices.
 */
export function withoutWarp(entries: readonly WarpListEntry[], warpId: string): WarpListEntry[] {
  const removed = entries.find((entry) => entry.id === warpId);
  if (!removed) return [...entries];
  let label = 0;
  return entries
    .filter((entry) => entry.id !== warpId)
    .map((entry) =>
      entry.namespaceId === removed.namespaceId ? { ...entry, label: ++label } : entry,
    );
}

/** The entries of one namespace, in list order, so a rendered list can print its heading once. */
export type WarpListGroup = {
  namespaceId: string;
  namespaceName: string;
  isCurrent: boolean;
  entries: WarpListEntry[];
};

/** Groups an already-ordered list by namespace, keeping the order the entries arrived in. */
export function groupWarpEntries(entries: readonly WarpListEntry[]): WarpListGroup[] {
  const groups: WarpListGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.namespaceId === entry.namespaceId) last.entries.push(entry);
    else
      groups.push({
        namespaceId: entry.namespaceId,
        namespaceName: entry.namespaceName,
        isCurrent: entry.isCurrent,
        entries: [entry],
      });
  }
  return groups;
}

type BuildWarpDirectory = {
  namespaces: readonly { id: string; name: string }[];
  /** Every warp in the workspace, each carrying the namespace it belongs to. */
  warps: readonly Warp[];
  cards: readonly (HintCard & { namespaceId: string })[];
  /** What the boards draw their cards at, which decides what a warp is sitting on. */
  metrics: CardMetrics;
  /** The namespace the page is already showing, whose entries the client derives live. */
  excludeNamespaceId: string;
};

/**
 * The palette rows for every namespace except the one being viewed, in `namespaces` order.
 * Shared by the page load and the warp-directory endpoint so the two cannot drift, and
 * built from the same {@link warpEntriesForNamespace} the client uses for its own namespace.
 */
export function buildWarpDirectory({
  namespaces,
  warps,
  cards,
  metrics,
  excludeNamespaceId,
}: BuildWarpDirectory): WarpListEntry[] {
  // Bucket cards once to avoid rescanning them for every namespace.
  const warpsByNamespace = groupByNamespace(warps);
  const cardsByNamespace = groupByNamespace(cards);
  return namespaces.flatMap((namespace) =>
    namespace.id === excludeNamespaceId
      ? []
      : warpEntriesForNamespace({
          namespace,
          warps: warpsByNamespace.get(namespace.id) ?? [],
          cards: cardsByNamespace.get(namespace.id) ?? [],
          metrics,
          isCurrent: false,
        }),
  );
}

/** Rows by the namespace they belong to, each bucket in the order the rows arrived. */
function groupByNamespace<T extends { namespaceId: string }>(rows: readonly T[]): Map<string, T[]> {
  const byNamespace = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byNamespace.get(row.namespaceId);
    if (bucket) bucket.push(row);
    else byNamespace.set(row.namespaceId, [row]);
  }
  return byNamespace;
}
