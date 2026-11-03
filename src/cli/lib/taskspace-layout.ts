/**
 * Finding and fixing taskspace directories that are not where Kozane now puts them.
 *
 * Older workspaces put new taskspaces at `<root>/<name>`, and their config says
 * `"defaultDir": "."`. The current layout is `<root>/taskspaces/<namespace>/<name>`. Only
 * directories Kozane created itself (`ownsDirectory: true` in the marker) are moved. Any
 * other directory is the user's and stays where it is.
 *
 * `kozane open` refuses to start while a move out of the old layout is pending, and
 * `kozane doctor --fix` makes it. Other moves, such as after a namespace was renamed, are
 * only reported.
 */
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllTaskspaces, updateTaskspace } from "../../db/api/taskspace.js";
import type { DB } from "../../db/tx.js";
import { DEFAULT_TASKSPACE_DIR } from "../../lib/constants.js";
import { errorMessage } from "../../lib/error-message.js";
import { isPlainObject } from "../../lib/plain-object.js";
import { writeFileAtomic } from "../../lib/server/atomic-write.js";
import { isStrictlyInside, isWithin, sameEntry } from "../../lib/server/fs-paths.js";
import { TaskspaceFilesError } from "../../lib/server/taskspace-files.js";
import { MIN_SHORT_ID_LENGTH, shortIdKey } from "../../lib/short-id-key.js";
import {
  enclosingTaskspaceDirs,
  holdsOtherTaskspaces,
  isManagedTaskspaceDirectory,
  missingDirs,
  moveTaskspaceDirectory,
  removeEmptyDirs,
  restoreTaskspaceDirectory,
  taskspaceDirectoryClaim,
} from "../../lib/server/taskspace-directory.js";
import {
  AmbiguousNamespacePathError,
  folderKey,
  namespaceFolders,
  taskspaceParentDir,
} from "../../lib/taskspace-location.js";
import { CONFIG_FILE, KOZANE_DIR, type WorkspaceConfig } from "./config.js";

/** One owned taskspace directory to move. `from` is workspace-relative. `to` may be absolute. */
export type LayoutMove = {
  taskspaceId: string;
  name: string;
  from: string;
  to: string;
  /**
   * The directory follows the legacy layout at the workspace root or in a namespace
   * folder there. These moves block `kozane open`. Moves caused by namespace renames
   * are reported only by `kozane doctor`.
   */
  oldLayout: boolean;
};

/**
 * An owned directory that is not where the layout puts it, but that Kozane cannot move.
 * `move.to` is where it would go, absolute when that is outside the workspace.
 */
export type LayoutSkip = { move: LayoutMove; reason: string };

export type LayoutPlan = {
  /** config.json still has the `"defaultDir": "."` an older `kozane init` wrote. */
  legacyDefaultDir: boolean;
  moves: LayoutMove[];
  /**
   * Directories that need attention but cannot move automatically. After the legacy
   * config is rewritten, directories outside the new layout are unmanaged. Browser
   * rename changes only their label, and delete keeps their directory.
   */
  skipped: LayoutSkip[];
};

export type LayoutResult = {
  /**
   * `updated`: the legacy `defaultDir` was rewritten. `kept`: it was left because a move
   * failed, and running the fix again retries. `unchanged`: the config was not legacy, or
   * was edited while the fix ran so it no longer is.
   */
  config: "updated" | "kept" | "unchanged";
  moved: LayoutMove[];
  failed: { move: LayoutMove; reason: string }[];
};

function configPath(root: string): string {
  return join(root, KOZANE_DIR, CONFIG_FILE);
}

function readRawConfig(root: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(configPath(root), "utf-8"));
  if (!isPlainObject(parsed)) throw new Error("Invalid Kozane config");
  return parsed;
}

/**
 * Recognize the legacy layout when `defaultDir` is empty, `.` or `./` and `namespaceDirs`
 * is absent. An explicit `namespaceDirs` setting preserves the chosen layout.
 */
function hasLegacyDefaultDir(raw: Record<string, unknown>): boolean {
  const section = raw.taskspace;
  if (!isPlainObject(section) || "namespaceDirs" in section) return false;
  return typeof section.defaultDir === "string" && ["", ".", "./"].includes(section.defaultDir);
}

/**
 * Whether config.json still has the legacy `"defaultDir": "."`. Only then can a directory be
 * in the old layout, so `kozane open` checks this first and skips reading every marker.
 */
export function usesLegacyDefaultDir(root: string): boolean {
  return hasLegacyDefaultDir(readRawConfig(root));
}

/**
 * Work out which owned taskspace directories are not where the layout puts them. A legacy
 * `defaultDir` counts as `taskspaces`, since `--fix` rewrites it to that.
 *
 * A taskspace is left out when Kozane would never move it: no namespace, a path outside the
 * workspace, a directory it did not create, or an ambiguous `namespacePaths` key, which
 * `kozane doctor` reports on its own. An owned directory that is out of place but cannot move,
 * because it holds another taskspace or its target is outside the workspace or inside another
 * taskspace, is listed in `skipped`, and so is an out-of-place one whose marker could not be
 * read.
 */
export async function planTaskspaceLayout(
  db: DB,
  root: string,
  config: WorkspaceConfig,
): Promise<LayoutPlan> {
  const legacyDefaultDir = hasLegacyDefaultDir(readRawConfig(root));
  const placement = {
    ...config.taskspace,
    defaultDir: legacyDefaultDir ? DEFAULT_TASKSPACE_DIR : config.taskspace.defaultDir,
  };
  const workspaceRoot = resolve(root);
  const namespaces = await getAllNamespaces({ db });
  const moves: LayoutMove[] = [];
  const skipped: LayoutSkip[] = [];
  // Apply the browser's legacy placement rules to directories at the workspace root
  // or in a current namespace's folder there.
  const folders = namespaceFolders(namespaces);
  const legacyPlacement = { defaultDir: config.taskspace.defaultDir, namespacePaths: {} };
  const inOldLayout = (storedPath: string) =>
    legacyDefaultDir &&
    isManagedTaskspaceDirectory({
      workspaceRoot,
      storedPath,
      pathKind: "workspace_relative",
      placement: legacyPlacement,
      namespaces,
      folders,
    });

  const taskspaces = await getAllTaskspaces({ db });
  for (const taskspace of taskspaces) {
    const { id, name, path, pathKind, namespaceId } = taskspace;
    if (!path || pathKind !== "workspace_relative" || !namespaceId) continue;
    let parentDir: string;
    try {
      parentDir = taskspaceParentDir({ ...placement, namespaceId, namespaces, folders });
    } catch (e) {
      // `kozane taskspace create` reports an ambiguous key on its own.
      if (e instanceof AmbiguousNamespacePathError) continue;
      throw e;
    }
    const target = resolve(workspaceRoot, parentDir, basename(path));
    if (target === resolve(workspaceRoot, path)) continue;
    // A case-insensitive disk finds `taskspaces/Work/x` at `taskspaces/work/x`, such as after
    // a namespace "Work" was renamed "work", so there is nothing to move.
    if (sameDirectoryByCase(target, resolve(workspaceRoot, path))) continue;
    const inside = isStrictlyInside(workspaceRoot, target);
    const move: LayoutMove = {
      taskspaceId: id,
      name,
      from: path,
      to: inside ? relative(workspaceRoot, target) : target,
      oldLayout: inOldLayout(path),
    };
    let claim;
    try {
      claim = taskspaceDirectoryClaim({ workspaceRoot, storedPath: path, taskspaceId: id });
    } catch (e) {
      // An unreadable directory has unknown ownership. Leave it in place and report it.
      skipped.push({ move, reason: `it could not be read (${errorMessage(e)})` });
      continue;
    }
    if (claim !== "owned") continue;
    if (!inside) skipped.push({ move, reason: "its target is outside the workspace" });
    // Moving it would carry another taskspace along and break that one's record.
    else if (holdsOtherTaskspaces(workspaceRoot, taskspace, taskspaces))
      skipped.push({ move, reason: "it holds another taskspace" });
    else moves.push(move);
  }
  const nested = withoutNesting(workspaceRoot, moves);
  return { legacyDefaultDir, moves: nested.kept, skipped: [...skipped, ...nested.dropped] };
}

/** Whether two paths differ only in case and name the same entry on this disk. */
function sameDirectoryByCase(a: string, b: string): boolean {
  if (folderKey(a) !== folderKey(b)) return false;
  try {
    return sameEntry(lstatSync(a), lstatSync(b));
  } catch {
    // A failed lookup cannot establish that both paths name the same directory.
    return false;
  }
}

/**
 * Exclude moves that would nest a taskspace inside another taskspace's current or planned
 * directory. Deleting the outer taskspace would also delete the inner one.
 *
 * A directory that moves away first does not block the target. For example, move a legacy
 * taskspace named `taskspaces` out of the root before placing other taskspaces under that path.
 */
function withoutNesting(
  workspaceRoot: string,
  moves: LayoutMove[],
): { kept: LayoutMove[]; dropped: LayoutSkip[] } {
  // Cache absolute paths and every enclosing marker. Moving the nearest enclosing
  // taskspace is insufficient if another enclosing taskspace stays in place.
  const paths = new Map(
    moves.map((move) => {
      const to = resolve(workspaceRoot, move.to);
      return [
        move,
        {
          from: resolve(workspaceRoot, move.from),
          to,
          enclosing: enclosingTaskspaceDirs(workspaceRoot, dirname(to)),
        },
      ];
    }),
  );
  const pathsOf = (move: LayoutMove) => paths.get(move)!;
  // Recheck after excluding moves. Each excluded directory stays in place and may block
  // another target. Each round compares every pair of remaining moves.
  let kept = moves;
  const dropped: LayoutSkip[] = [];
  const insideOf = (dir: string) =>
    `its target would be inside the taskspace at ${relative(workspaceRoot, dir)}`;
  for (;;) {
    const leaving = new Set(kept.map((move) => pathsOf(move).from));
    const next = kept.filter((move) => {
      const { to, enclosing } = pathsOf(move);
      const staying = enclosing.find((dir) => !leaving.has(dir));
      if (staying !== undefined) {
        dropped.push({ move, reason: insideOf(staying) });
        return false;
      }
      // The disk check above cannot see where other moves land, such as a `namespacePaths`
      // entry pointing inside another taskspace's new directory.
      const host = kept.find((other) => other !== move && isStrictlyInside(pathsOf(other).to, to));
      if (host) {
        dropped.push({ move, reason: insideOf(pathsOf(host).to) });
        return false;
      }
      return true;
    });
    if (next.length !== kept.length) {
      kept = next;
      continue;
    }
    const { ordered, stuck } = moveOrder(kept, pathsOf);
    if (stuck.length === 0) return { kept: ordered, dropped };
    // Moves that wait on each other in a cycle cannot go, and neither can the moves that wait
    // on them. They stay where they are, which can nest others' targets, so check again.
    for (const { move, waitingOn } of stuck) {
      const blocker = pathsOf(waitingOn).from;
      const where =
        blocker === pathsOf(move).to
          ? `its target is where the taskspace at ${relative(workspaceRoot, blocker)} is`
          : insideOf(blocker);
      dropped.push({ move, reason: `${where}, which cannot move first` });
    }
    kept = ordered;
  }
}

/**
 * Move each directory before placing a taskspace at or inside its old path. Dependencies
 * apply at every depth. If C targets a path inside B and B targets a path inside A, move
 * A first, then B, then C.
 * Moves with nothing to wait for keep their order in the plan.
 *
 * A move that can never go, because it waits on a cycle of moves, comes back in `stuck` with
 * the move it is waiting on.
 */
function moveOrder(
  moves: readonly LayoutMove[],
  pathsOf: (move: LayoutMove) => { from: string; to: string },
): { ordered: LayoutMove[]; stuck: { move: LayoutMove; waitingOn: LayoutMove }[] } {
  // A target inside the source directory uses a two-step move and needs no dependency.
  // A target at another directory's current path waits for that directory to move away.
  const waitsOn = new Map(
    moves.map((move) => [
      move,
      moves.filter((other) => other !== move && isWithin(pathsOf(other).from, pathsOf(move).to)),
    ]),
  );
  const ordered: LayoutMove[] = [];
  const done = new Set<LayoutMove>();
  for (let progress = true; progress; ) {
    progress = false;
    for (const move of moves) {
      if (done.has(move) || !waitsOn.get(move)!.every((other) => done.has(other))) continue;
      ordered.push(move);
      done.add(move);
      progress = true;
    }
  }
  const stuck = moves
    .filter((move) => !done.has(move))
    .map((move) => ({ move, waitingOn: waitsOn.get(move)!.find((other) => !done.has(other))! }));
  return { ordered, stuck };
}

/** Whether `kozane doctor --fix` has anything to do. */
export function layoutNeedsFix(plan: LayoutPlan): boolean {
  return plan.legacyDefaultDir || plan.moves.length > 0;
}

/**
 * Whether the layout check fails because the config is legacy or a planned move leaves
 * the legacy layout. Moves caused by namespace renames do not fail the layout check.
 */
export function layoutIsOld(plan: LayoutPlan): boolean {
  return plan.legacyDefaultDir || plan.moves.some(({ oldLayout }) => oldLayout);
}

/**
 * Move each directory and update its record, then rewrite a legacy `defaultDir` to
 * `taskspaces`. Other config keys are kept as they are.
 *
 * The config changes only when every move succeeded. Otherwise it keeps `"defaultDir": "."`,
 * so `kozane open` still refuses to start and running the fix again retries the rest. The
 * plan already counts a legacy `defaultDir` as `taskspaces`, so the moved ones stay put.
 */
export async function applyTaskspaceLayout(
  db: DB,
  root: string,
  plan: LayoutPlan,
): Promise<LayoutResult> {
  const result: LayoutResult = { config: "unchanged", moved: [], failed: [] };
  const workspaceRoot = resolve(root);
  for (const move of plan.moves) {
    // Recheck enclosing taskspaces in case an earlier move failed. The source directory
    // itself is allowed because a target inside it uses a two-step move.
    const from = resolve(workspaceRoot, move.from);
    const enclosing = enclosingTaskspaceDirs(
      workspaceRoot,
      dirname(resolve(workspaceRoot, move.to)),
    ).find((dir) => dir !== from);
    if (enclosing !== undefined) {
      result.failed.push({
        move,
        reason:
          `its target would be inside the taskspace at ${relative(workspaceRoot, enclosing)}, ` +
          "which did not move",
      });
      continue;
    }
    let undo: () => void;
    try {
      undo = moveDirectory(workspaceRoot, move);
    } catch (e) {
      result.failed.push({ move, reason: moveFailure(move, e) });
      continue;
    }
    try {
      await updateTaskspace({ db, taskspaceId: move.taskspaceId, path: move.to });
      result.moved.push(move);
    } catch (e) {
      // Put the directory back so the record still points at it. If that fails too, say so
      // and go on with the other moves.
      const reason = errorMessage(e);
      try {
        undo();
        result.failed.push({ move, reason });
      } catch (undoError) {
        result.failed.push({
          move,
          reason:
            `${reason}. Could not move it back (${errorMessage(undoError)}), so its record no ` +
            `longer matches the directory; run kozane taskspace scan --apply to update it`,
        });
      }
    }
  }

  if (plan.legacyDefaultDir) {
    const raw = readRawConfig(root);
    if (result.failed.length > 0) {
      result.config = "kept";
    } else if (hasLegacyDefaultDir(raw) && isPlainObject(raw.taskspace)) {
      // Checked again on the file as it is now, so a layout the user chose while the moves
      // ran is not overwritten.
      raw.taskspace.defaultDir = DEFAULT_TASKSPACE_DIR;
      writeFileAtomic(configPath(root), JSON.stringify(raw, null, 2) + "\n");
      result.config = "updated";
    }
  }
  return result;
}

/** Why a move failed, plus what to do when something is in the way. */
function moveFailure(move: LayoutMove, e: unknown): string {
  if (!(e instanceof TaskspaceFilesError && e.reason === "exists")) return errorMessage(e);
  return (
    `${move.to} already exists. Move it aside, or rename ${move.from} and run ` +
    `kozane taskspace scan --apply, then run kozane doctor --fix again`
  );
}

/**
 * Move one owned directory to its target and return how to undo it. A target inside the
 * directory itself, such as `taskspaces` → `taskspaces/main/taskspaces` for a taskspace named
 * after the new default directory, cannot be reached in one rename, so the directory is moved
 * aside first.
 *
 * Each step returns an undo function that restores the directory and removes empty parent
 * folders created by that step. Undo the second step before the first.
 *
 *   move:  from ──step 1──▶ aside ──step 2──▶ to
 *   undo:  from ◀──undo 1── aside ◀──undo 2── to    (undo 2 runs first)
 *
 * If step 2 fails, undo 1 runs at once, so a failed move leaves the directory at `from`.
 */
function moveDirectory(workspaceRoot: string, { taskspaceId, from, to }: LayoutMove): () => void {
  const step = (stepFrom: string, stepTo: string) => {
    // Folders this step makes, so an undo does not leave them behind.
    const parents = missingDirs(dirname(resolve(workspaceRoot, stepTo)));
    moveTaskspaceDirectory({
      workspaceRoot,
      storedPath: stepFrom,
      taskspaceId,
      nextStored: stepTo,
    });
    return () => {
      restoreTaskspaceDirectory(workspaceRoot, stepTo, stepFrom);
      removeEmptyDirs(parents);
    };
  };
  if (!isStrictlyInside(resolve(workspaceRoot, from), resolve(workspaceRoot, to)))
    return step(from, to);

  const aside = `${from}.kozane-move-${shortIdKey(taskspaceId).slice(0, MIN_SHORT_ID_LENGTH)}`;
  let undoAside: () => void;
  try {
    undoAside = step(from, aside);
  } catch (e) {
    // Name the path in the way. `moveFailure` would otherwise blame the final target.
    if (e instanceof TaskspaceFilesError && e.reason === "exists")
      throw new Error(
        `${aside} already exists, and the move goes through it. Move it aside, then run ` +
          "kozane doctor --fix again",
        { cause: e },
      );
    throw e;
  }
  let undoTarget: () => void;
  try {
    undoTarget = step(aside, to);
  } catch (e) {
    try {
      undoAside();
    } catch (undoError) {
      throw new Error(
        `${errorMessage(e)}. Could not move it back from ${aside} (${errorMessage(undoError)}); ` +
          `run kozane taskspace scan --apply to update its record`,
        { cause: undoError },
      );
    }
    throw e;
  }
  return () => {
    undoTarget();
    undoAside();
  };
}

/** Maximum entries to list before summarizing the rest. */
const LISTED_MOVES = 5;

/** One line per skipped directory, such as `notes stays: it holds another taskspace`, capped. */
export function describeSkips(skipped: readonly LayoutSkip[], indent = "  "): string[] {
  const lines = skipped
    .slice(0, LISTED_MOVES)
    .map(({ move, reason }) => `${indent}${move.from} stays: ${reason}`);
  if (skipped.length > LISTED_MOVES)
    lines.push(`${indent}…and ${skipped.length - LISTED_MOVES} more`);
  return lines;
}

/** One line per move, such as `notes → taskspaces/Work/notes`, capped at a few. */
export function describeMoves(moves: readonly LayoutMove[], indent = "  "): string[] {
  const lines = moves.slice(0, LISTED_MOVES).map(({ from, to }) => `${indent}${from} → ${to}`);
  if (moves.length > LISTED_MOVES) lines.push(`${indent}…and ${moves.length - LISTED_MOVES} more`);
  return lines;
}
