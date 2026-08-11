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

/** Anything positioned on a board that can lend a warp its hint. */
export type HintCard = { posX: number; posY: number; content: string; zIndex?: number };

/** What every card on a board is drawn at, which is what turns a position into a box. */
export type CardMetrics = { cardWidth: number; fontSize: number };

/**
 * How far a card's edge may sit from a warp and still describe it, in world pixels. Two
 * card widths: past that the nearest card is somewhere else on the board, and naming it
 * would point at the wrong place.
 */
export const WARP_HINT_RADIUS = 480;

// The card's own chrome, from KozaneCard.svelte: 8px above and below the text, a footer
// that holds its space even when hidden, and a floor under the content block.
const CARD_PADDING_X = 20;
const CARD_PADDING_Y = 16;
const CARD_FOOTER_HEIGHT = 24;
const CARD_MIN_CONTENT_HEIGHT = 44;
const CARD_LINE_HEIGHT_RATIO = 1.65;
/** Width of one character relative to the font size, for the monospace the cards default to. */
const CHAR_WIDTH_RATIO = 0.6;

/**
 * How tall a card with this content comes out, near enough. Cards store a position but no
 * size — the width is the same for all of them and the height is whatever the text wraps
 * to — so a warp that has to know what it is sitting on has to estimate it.
 */
export function estimateCardHeight(content: string, { cardWidth, fontSize }: CardMetrics): number {
  const charsPerLine = Math.max(
    1,
    Math.floor((cardWidth - CARD_PADDING_X) / (fontSize * CHAR_WIDTH_RATIO)),
  );
  const lines = content
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  const textHeight = lines * fontSize * CARD_LINE_HEIGHT_RATIO + CARD_PADDING_Y;
  return Math.max(CARD_MIN_CONTENT_HEIGHT, textHeight) + CARD_FOOTER_HEIGHT;
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
    point.posY - (card.posY + estimateCardHeight(card.content, metrics)),
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
  return projects.flatMap((project) =>
    project.id === excludeProjectId
      ? []
      : warpEntriesForProject({
          project,
          warps: warps.filter((warp) => warp.projectId === project.id),
          cards: cards.filter((card) => card.projectId === project.id),
          metrics,
          isCurrent: false,
        }),
  );
}
