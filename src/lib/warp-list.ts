import type { Warp } from "./types.js";

/**
 * One row of the cross-project warp palette. `label` is the warp's number on its own
 * board — numbering restarts per project, so a row and the marker it stands for always
 * carry the same digit.
 */
export type WarpListEntry = {
  id: string;
  projectId: string;
  projectName: string;
  label: number;
  posX: number;
  posY: number;
  /** Text of the card nearest the warp, or null when nothing is close enough. */
  hint: string | null;
  isCurrent: boolean;
};

/**
 * Anything positioned on a board that can lend a warp its hint. `content` may be only the
 * opening of the card — see {@link HintCard.contentChars}.
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
};

/** What every card on a board is drawn at, which is what turns a position into a box. */
export type CardMetrics = { cardWidth: number; fontSize: number };

/**
 * The metrics a workspace's UI settings imply. The two names differ — `defaultCardWidth`
 * is a setting, `cardWidth` is what a card is drawn at — and doing the rename in one place
 * is what keeps a caller from quietly passing the font size as the width.
 */
export function cardMetrics(ui: {
  defaultCardWidth: number;
  defaultFontSize: number;
}): CardMetrics {
  return { cardWidth: ui.defaultCardWidth, fontSize: ui.defaultFontSize };
}

/**
 * How far a card's edge may sit from a warp and still describe it, in world pixels. Two
 * card widths: past that the nearest card is somewhere else on the board, and naming it
 * would point at the wrong place.
 */
export const WARP_HINT_RADIUS = 480;

/**
 * The card's own chrome, transcribed from KozaneCard.svelte: 8px above and below the text,
 * a footer that holds its space even when hidden, and a floor under the content block.
 *
 * Transcribed rather than imported because the component states them inside `css({...})`,
 * which Panda extracts at build time and so cannot read from a variable. Exported instead,
 * so `warp-list.test.ts` can hold these against the component's own styles: a card
 * restyled without touching them leaves every hint naming the wrong neighbour, and a
 * plausible wrong hint is not something anyone would notice.
 */
export const CARD_BOX = {
  /** Left plus right padding. */
  paddingX: 20,
  /** Top plus bottom padding. */
  paddingY: 16,
  /** Only the footer's own height is estimated; the rest are the component's literals. */
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
 * Code point ranges a monospace font draws at double width: the CJK blocks, Hangul, the
 * fullwidth forms, and the emoji. Kozane is a こざね法 tool, so a board of Japanese cards is
 * the ordinary case rather than the exotic one — counting those characters as narrow
 * would halve every estimate.
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
 * How tall a card with this content comes out, near enough. Cards store a position but no
 * size — the width is the same for all of them and the height is whatever the text wraps
 * to — so a warp that has to know what it is sitting on has to estimate it.
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

/**
 * How tall a hint card is drawn, whether it arrived whole or as an opening. A card read
 * for the palette carries only its first few hundred characters, and measuring that as the
 * whole card would draw a long note as a short one — so the opening is measured and scaled
 * by how much text there turned out to be, taking it as representative of the rest. That
 * assumption is what a hint is worth: an estimate of which card a warp is sitting on, made
 * the same way wherever the row is built, so a warp is named after the same card whether
 * it is read from its own board or from another project's.
 */
function hintCardHeight(card: HintCard, metrics: CardMetrics): number {
  const measured = estimateCardHeight(card.content, metrics);
  const sampled = [...card.content].length;
  if (card.contentChars === undefined || sampled === 0) return measured;
  return measured * Math.max(1, card.contentChars / sampled);
}

/**
 * Squared distance from a point to a card's box, which is zero anywhere inside it. Squared
 * throughout: the ordering is the same as the real distance, without the square root.
 */
function squaredDistanceToCard(
  point: { posX: number; posY: number },
  card: HintCard,
  metrics: CardMetrics,
): number {
  const dx = Math.max(card.posX - point.posX, 0, point.posX - (card.posX + metrics.cardWidth));
  const dy = Math.max(
    card.posY - point.posY,
    0,
    point.posY - (card.posY + hintCardHeight(card, metrics)),
  );
  return dx * dx + dy * dy;
}

/** Hints ride in a single narrow row, so a long card is cut rather than wrapped. */
export const WARP_HINT_MAX_CHARS = 48;

function condense(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length > WARP_HINT_MAX_CHARS
    ? `${oneLine.slice(0, WARP_HINT_MAX_CHARS - 1).trimEnd()}…`
    : oneLine;
}

/**
 * The text of the card describing where `warp` is, condensed to one short line. Measured
 * to each card's box rather than to the corner it is positioned by: a warp dropped on a
 * card is zero away from it, so the card under the marker always wins — which is the one
 * the eye reads it as marking, even when some other card's corner happens to sit nearer.
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
    // Nearer wins; between two cards the warp sits on, the one stacked on top does, since
    // that is the one being looked at. Both comparisons are strict, so an outright tie
    // falls to the first card — `cards` arrives in a stable order.
    if (distance > bestDistance || (distance === bestDistance && zIndex <= bestZIndex)) continue;
    best = card;
    bestDistance = distance;
    bestZIndex = zIndex;
  }
  return best ? condense(best.content) : null;
}

type WarpEntriesForProject = {
  project: { id: string; name: string };
  /** In the order `getAllWarps` returns them: creation order, which is what markers show. */
  warps: readonly Warp[];
  cards: readonly HintCard[];
  metrics: CardMetrics;
  isCurrent: boolean;
};

export function warpEntriesForProject({
  project,
  warps,
  cards,
  metrics,
  isCurrent,
}: WarpEntriesForProject): WarpListEntry[] {
  return warps.map((warp, index) => ({
    id: warp.id,
    projectId: project.id,
    projectName: project.name,
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
 * The list without `warpId`, with the project it belonged to renumbered: a removed warp
 * renumbers the markers on its board, and the list has to say the same thing. Entries of
 * one project are contiguous, so one counter is enough.
 */
export function withoutWarp(entries: readonly WarpListEntry[], warpId: string): WarpListEntry[] {
  const removed = entries.find((entry) => entry.id === warpId);
  if (!removed) return [...entries];
  let label = 0;
  return entries
    .filter((entry) => entry.id !== warpId)
    .map((entry) => (entry.projectId === removed.projectId ? { ...entry, label: ++label } : entry));
}

/** The entries of one project, in list order, so a rendered list can print its heading once. */
export type WarpListGroup = {
  projectId: string;
  projectName: string;
  isCurrent: boolean;
  entries: WarpListEntry[];
};

/** Groups an already-ordered list by project, keeping the order the entries arrived in. */
export function groupWarpEntries(entries: readonly WarpListEntry[]): WarpListGroup[] {
  const groups: WarpListGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.projectId === entry.projectId) last.entries.push(entry);
    else
      groups.push({
        projectId: entry.projectId,
        projectName: entry.projectName,
        isCurrent: entry.isCurrent,
        entries: [entry],
      });
  }
  return groups;
}

type BuildWarpDirectory = {
  projects: readonly { id: string; name: string }[];
  /** Every warp in the workspace, each carrying the project it belongs to. */
  warps: readonly Warp[];
  cards: readonly (HintCard & { projectId: string })[];
  /** What the boards draw their cards at, which decides what a warp is sitting on. */
  metrics: CardMetrics;
  /** The project the page is already showing, whose entries the client derives live. */
  excludeProjectId: string;
};

/**
 * The palette rows for every project except the one being viewed, in `projects` order.
 * Shared by the page load and the warp-directory endpoint so the two cannot drift, and
 * built from the same {@link warpEntriesForProject} the client uses for its own project.
 */
export function buildWarpDirectory({
  projects,
  warps,
  cards,
  metrics,
  excludeProjectId,
}: BuildWarpDirectory): WarpListEntry[] {
  // Bucketed once instead of filtered inside the loop: a workspace's cards are scanned
  // one time between them all, rather than once for every project it holds.
  const warpsByProject = groupByProject(warps);
  const cardsByProject = groupByProject(cards);
  return projects.flatMap((project) =>
    project.id === excludeProjectId
      ? []
      : warpEntriesForProject({
          project,
          warps: warpsByProject.get(project.id) ?? [],
          cards: cardsByProject.get(project.id) ?? [],
          metrics,
          isCurrent: false,
        }),
  );
}

/** Rows by the project they belong to, each bucket in the order the rows arrived. */
function groupByProject<T extends { projectId: string }>(rows: readonly T[]): Map<string, T[]> {
  const byProject = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = byProject.get(row.projectId);
    if (bucket) bucket.push(row);
    else byProject.set(row.projectId, [row]);
  }
  return byProject;
}
