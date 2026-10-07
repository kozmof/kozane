import type { ScopeArea, TaskspaceEntry, TaskspaceSummary, TaskspaceTruncation } from "$lib/types";
import type { TaskspaceNode, TaskspaceTreeContext } from "./taskspace-tree.svelte.js";

/**
 * Calculate scope-frame file groups, ordering, and layout from frame navigation, taskspaces,
 * and cached directory data. Keep these functions independent of reactive state for direct
 * tests.
 */

/** How wide one icon cell is drawn, in canvas pixels. Sized to hold a two-line label. */
export const CELL_WIDTH = 64;

/** Icon-cell height in canvas pixels, including the glyph and two label lines. */
export const CELL_HEIGHT = 46;

/**
 * Maximum icon rows per taskspace before remaining entries become a `+N` chip. Keep full
 * directory browsing in the panel.
 */
export const MAX_ROWS = 2;

/**
 * Minimum file-strip width in canvas pixels. The strip sits outside its frame and may be
 * wider so narrow frames can still show files.
 */
export const MIN_STRIP_WIDTH = 260;

/**
 * How far below the frame's bottom edge the strip starts, in canvas pixels.
 *
 * Clear of the resize handle, which is anchored at `bottom: -1px` with a height of 14 and so
 * hangs 13px below the edge. An icon under it would be a cell you cannot click.
 */
export const STRIP_GAP = 18;

/** One thing drawn in the strip. */
export type FileCell =
  /** The way back out of a directory drilled into. Always first, and only when inside one. */
  | { kind: "up"; label: string; path: string }
  | { kind: "entry"; entry: TaskspaceEntry; path: string };

/** One taskspace's strip with its current directory and entries. */
export type FileGroup = {
  taskspaceId: string;
  /** The taskspace's own name, drawn as a label only when a scope has more than one. */
  name: string;
  /** The directory being shown, relative to the taskspace root. Empty is the root. */
  path: string;
  cells: FileCell[];
  truncated: TaskspaceTruncation | null;
  loading: boolean;
  error: string | null;
  /**
   * Whether the directory was loaded. Distinguish an empty result from a directory not yet
   * requested.
   */
  read: boolean;
};

/**
 * Select taskspaces that can be browsed through a live path or an embedded export tree. Share
 * this rule with the sidebar.
 */
export function taskspacesForScope(
  taskspaces: TaskspaceSummary[],
  scopeId: string,
  staticFiles?: TaskspaceTreeContext["staticFiles"],
): TaskspaceSummary[] {
  return taskspaces.filter(
    (taskspace) =>
      taskspace.scopeId === scopeId &&
      (taskspace.path !== null || staticFiles?.[taskspace.id] !== undefined),
  );
}

/**
 * Sort directories first, then names using locale comparison. Treat symlinks and other entry
 * kinds like files for ordering.
 */
export function sortEntries(entries: TaskspaceEntry[]): TaskspaceEntry[] {
  return [...entries].sort((a, b) => {
    const aDirectory = a.kind === "directory";
    const bDirectory = b.kind === "directory";
    if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The key one frame's view of one taskspace is remembered under. */
export function cwdKey(areaId: string, taskspaceId: string): string {
  return `${areaId}:${taskspaceId}`;
}

/** Which directory a frame is showing of one taskspace. The root, until it is drilled into. */
export function cwdFor(
  cwdByKey: Record<string, string>,
  areaId: string,
  taskspaceId: string,
): string {
  return cwdByKey[cwdKey(areaId, taskspaceId)] ?? "";
}

/** The directory `path` sits in, or empty when it sits at the taskspace root. */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** Final path segment used as the directory name. */
export function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

type FileGroupsForArea = {
  /** The frame these are drawn under, which is what its view of each taskspace is keyed by. */
  areaId: string;
  /** Already narrowed to the area's scope by {@link taskspacesForScope}. */
  taskspaces: TaskspaceSummary[];
  /** Which directory each frame is showing of each taskspace. See {@link cwdFor}. */
  cwdByKey: Record<string, string>;
  /** What the tree cache holds for one directory. */
  nodeOf: (taskspaceId: string, path: string) => TaskspaceNode;
};

/**
 * Build one file group per taskspace for this frame's current directories. Keep navigation
 * independent between frames sharing a scope.
 */
export function fileGroupsForArea({
  areaId,
  taskspaces,
  cwdByKey,
  nodeOf,
}: FileGroupsForArea): FileGroup[] {
  return taskspaces.map((taskspace) => {
    const path = cwdFor(cwdByKey, areaId, taskspace.id);
    const node = nodeOf(taskspace.id, path);
    const cells: FileCell[] = [];

    // The way out comes first, so it keeps its place as the grid rewraps rather than moving
    // about among the names.
    if (path) cells.push({ kind: "up", label: baseName(path), path: parentPath(path) });

    for (const entry of sortEntries(node.entries ?? [])) {
      cells.push({ kind: "entry", entry, path: path ? `${path}/${entry.name}` : entry.name });
    }

    return {
      taskspaceId: taskspace.id,
      name: taskspace.name,
      path,
      cells,
      truncated: node.truncated,
      loading: node.loading,
      error: node.error,
      read: node.entries !== null,
    };
  });
}

/** How wide the strip under `area` is laid out. */
export function stripWidth(area: Pick<ScopeArea, "width">): number {
  return Math.max(area.width, MIN_STRIP_WIDTH);
}

/** How many cells fit across a strip of this width. At least one, however narrow. */
export function columnsIn(width: number): number {
  return Math.max(1, Math.floor(width / CELL_WIDTH));
}

export type CellWindow = {
  cells: FileCell[];
  /** How many cells were left out, for the `+N` chip. Zero when they all fit. */
  overflow: number;
};

/**
 * Return cells that fit and count those omitted. Reserve one cell for the overflow chip when
 * needed so the strip stays within {@link MAX_ROWS} rows.
 */
export function visibleCells(
  cells: FileCell[],
  { width, maxRows = MAX_ROWS }: { width: number; maxRows?: number },
): CellWindow {
  const capacity = columnsIn(width) * maxRows;
  if (cells.length <= capacity) return { cells, overflow: 0 };
  // One slot goes to the chip. `max(0, …)` for the degenerate single-slot strip, where the
  // honest thing to draw is the chip alone rather than one arbitrary name beside nothing.
  const shown = Math.max(0, capacity - 1);
  return { cells: cells.slice(0, shown), overflow: cells.length - shown };
}

/**
 * Retain `cwd` entries only while both their frame and taskspace exist. Recreated frames have
 * new IDs. See `TaskspaceTreeState.prune` for cache cleanup.
 */
export function pruneCwd(
  cwdByKey: Record<string, string>,
  areaIds: Iterable<string>,
  taskspaceIds: Iterable<string>,
): Record<string, string> {
  const areas = new Set(areaIds);
  const taskspaces = new Set(taskspaceIds);
  return Object.fromEntries(
    Object.entries(cwdByKey).filter(([key]) => {
      const cut = key.indexOf(":");
      return areas.has(key.slice(0, cut)) && taskspaces.has(key.slice(cut + 1));
    }),
  );
}
