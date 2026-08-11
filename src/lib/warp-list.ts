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
export type HintCard = { posX: number; posY: number; content: string };

/**
 * How far a card may sit from a warp and still describe it, in world pixels. Two card
 * widths: past that the nearest card is somewhere else on the board, and naming it would
 * point at the wrong place.
 */
export const WARP_HINT_RADIUS = 480;

/** Hints ride in a single narrow row, so a long card is cut rather than wrapped. */
export const WARP_HINT_MAX_CHARS = 48;

function condense(content: string): string {
  const oneLine = content.replace(/\s+/gu, " ").trim();
  return oneLine.length > WARP_HINT_MAX_CHARS
    ? `${oneLine.slice(0, WARP_HINT_MAX_CHARS - 1).trimEnd()}…`
    : oneLine;
}

/**
 * The text of the card closest to `warp`, condensed to one short line. Compared by squared
 * distance: the ordering is the same as the real distance, without the square root.
 */
export function nearestCardHint(
  warp: { posX: number; posY: number },
  cards: readonly HintCard[],
): string | null {
  const limit = WARP_HINT_RADIUS * WARP_HINT_RADIUS;
  let best: HintCard | null = null;
  let bestDistance = Infinity;
  for (const card of cards) {
    if (card.content.trim() === "") continue;
    const dx = card.posX - warp.posX;
    const dy = card.posY - warp.posY;
    const distance = dx * dx + dy * dy;
    // Strictly nearer, so the first card wins a tie: `cards` arrives in a stable order.
    if (distance > limit || distance >= bestDistance) continue;
    best = card;
    bestDistance = distance;
  }
  return best ? condense(best.content) : null;
}

type WarpEntriesForProject = {
  project: { id: string; name: string };
  /** In the order `getAllWarps` returns them: creation order, which is what markers show. */
  warps: readonly Warp[];
  cards: readonly HintCard[];
  isCurrent: boolean;
};

export function warpEntriesForProject({
  project,
  warps,
  cards,
  isCurrent,
}: WarpEntriesForProject): WarpListEntry[] {
  return warps.map((warp, index) => ({
    id: warp.id,
    projectId: project.id,
    projectName: project.name,
    label: index + 1,
    posX: warp.posX,
    posY: warp.posY,
    hint: nearestCardHint(warp, cards),
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
  excludeProjectId,
}: BuildWarpDirectory): WarpListEntry[] {
  return projects.flatMap((project) =>
    project.id === excludeProjectId
      ? []
      : warpEntriesForProject({
          project,
          warps: warps.filter((warp) => warp.projectId === project.id),
          cards: cards.filter((card) => card.projectId === project.id),
          isCurrent: false,
        }),
  );
}
