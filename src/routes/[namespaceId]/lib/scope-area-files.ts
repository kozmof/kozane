import type { ScopeArea, TaskspaceEntry, TaskspaceSummary, TaskspaceTruncation } from "$lib/types";
import type { TaskspaceNode, TaskspaceTreeContext } from "./taskspace-tree.svelte.js";

/**
 * The icons a scope frame draws beneath it: which taskspace files belong under which frame,
 * in what order, and how many of them fit.
 *
 * All of it pure, and none of it reading `$state`. The canvas holds the one mutable thing
 * here — which directory each frame is currently showing — and everything else is derived
 * from that plus the taskspace rows and the tree cache. Kept out of `KozaneCanvas.svelte`
 * for the reason `gesture.ts` and `scope-area-request.ts` are: the arithmetic is worth
 * testing on its own, and that file is long enough already.
 */

/** How wide one icon cell is drawn, in canvas pixels. Sized to hold a two-line label. */
export const CELL_WIDTH = 64;

/** How tall one icon cell is drawn, in canvas pixels: the glyph plus two lines of label. */
export const CELL_HEIGHT = 46;

/**
 * How many rows of icons one taskspace may draw before the rest become a `+N` chip.
 *
 * A limit at all because a taskspace is an ordinary working directory: the listing endpoint
 * will hand back up to `TASKSPACE_DIR_ENTRIES_MAX` entries, and a frame trailing 500
 * icons down the board would bury whatever is under it. Two rows is enough to see what a
 * scope is working on, which is what these icons are for — the panel is still where you go
 * to read a directory.
 */
export const MAX_ROWS = 2;

/**
 * The narrowest the strip is laid out at, in canvas pixels, however narrow its frame is.
 *
 * The strip sits outside the frame rather than inside it, so its width is a choice rather
 * than a constraint — nothing clips it and it covers no card the frame holds. A frame may be
 * as small as `SCOPE_AREA_MIN_SIZE` (120), which is under two cells; sizing the strip to that
 * would turn a small frame's files into a `+N` chip and nothing else.
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

/** One taskspace's worth of strip: where it is pointed and what it found there. */
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
   * Whether the directory has been read at all. An empty directory and one not yet asked
   * about both have no cells, and the strip has different things to say about them — so the
   * distinction `TaskspaceNode` draws with a null `entries` is carried rather than flattened.
   */
  read: boolean;
};

/**
 * Which of a scope's taskspaces have files to draw.
 *
 * The same filter `ScopeSidebar` applies to the rows it unfolds: a taskspace with no `path`
 * is one this board cannot list — a static export's rows carry none — and is browsable only
 * where the export baked a tree in for it. Written here so the canvas and the panel cannot
 * drift into disagreeing about which taskspaces have files behind them.
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
 * Directories first, then by name.
 *
 * The listing endpoint hands back whatever order the directory was read in, which the panel's
 * tree passes straight through — a vertical list of rows reads fine in any order, and one
 * being read a folder at a time never shows two directories far apart. A wrapped grid does
 * not have that luxury: the only ordering it can be scanned by is the one it is drawn in.
 *
 * `localeCompare` rather than `<`, so an accented name sorts where a reader expects it rather
 * than after `z`. Symlinks and anything else sort with the files: what they are is in the
 * glyph, and a third sort class would put two names that look alike at opposite ends.
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

/** The last segment of `path` — what a directory is called, without what it sits under. */
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
 * What one frame draws: a group per taskspace of its scope, each holding the cells for the
 * directory that frame is currently pointed at.
 *
 * Per frame rather than per scope, and that is deliberate. A scope may be framed in several
 * places, each frame gets the icons, and drilling into a folder on one leaves the others
 * where they were — the same answer the frame's `×` gives to "which one did you mean": the
 * one you clicked.
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
 * As many of a group's cells as fit, and the count of those that did not.
 *
 * The chip takes a cell's place when it is needed, so the strip never grows past
 * {@link MAX_ROWS} rows: a frame's files take a fixed band of board below it whether the
 * taskspace holds four names or four hundred.
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
 * The `cwd` entries still worth remembering: those whose frame and taskspace are both still
 * there.
 *
 * A frame removed and drawn again is a new row with a new id, so its old entry would sit in
 * the map forever. Mirrors what `TaskspaceTreeState.prune` does for the cache itself.
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
