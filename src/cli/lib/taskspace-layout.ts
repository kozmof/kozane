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
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllTaskspaces, updateTaskspace } from "../../db/api/taskspace.js";
import type { DB } from "../../db/tx.js";
import { DEFAULT_TASKSPACE_DIR } from "../../lib/constants.js";
import { isPlainObject } from "../../lib/plain-object.js";
import { writeFileAtomic } from "../../lib/server/atomic-write.js";
import { isStrictlyInside } from "../../lib/server/fs-paths.js";
import { TaskspaceFilesError } from "../../lib/server/taskspace-files.js";
import { MIN_SHORT_ID_LENGTH, shortIdKey } from "../../lib/short-id-key.js";
import {
  enclosingTaskspaceDir,
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
  namespaceFolders,
  taskspaceParentDir,
} from "../../lib/server/taskspace-location.js";
import { CONFIG_FILE, KOZANE_DIR, type WorkspaceConfig } from "./config.js";

/** One owned taskspace directory to move. Both paths are relative to the workspace root. */
export type LayoutMove = {
  taskspaceId: string;
  name: string;
  from: string;
  to: string;
  /**
   * The directory is where a legacy `"defaultDir": "."` put it: at the workspace root, or in
   * a namespace folder there. Only these stop `kozane open`. Other moves, such as after a
   * namespace was renamed, are reported by `kozane doctor` alone.
   */
  oldLayout: boolean;
};

export type LayoutPlan = {
  /** config.json still has the `"defaultDir": "."` an older `kozane init` wrote. */
  legacyDefaultDir: boolean;
  moves: LayoutMove[];
};

export type LayoutResult = {
  /**
   * `updated`: the legacy `defaultDir` was rewritten. `kept`: it was left because a move
   * failed, and running the fix again retries. `unchanged`: the config was not legacy.
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
 * True for a config written before namespace folders existed: `defaultDir` is the workspace
 * root and `namespaceDirs` is not set. A config that sets `namespaceDirs` chose its layout.
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
 * A taskspace is left out when Kozane could not move it anyway: no namespace, a path outside
 * the workspace, a directory it did not create, a directory that holds another taskspace, or a
 * target outside the workspace, inside another taskspace, or under an ambiguous
 * `namespacePaths` key, which `kozane taskspace create` reports on its own.
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
  // Where the legacy config put directories: the browser's own rule for `"defaultDir": "."`,
  // directly at the root or in a current namespace's folder there.
  const folders = namespaceFolders(namespaces);
  const legacyFolders = [...folders.values()];
  const inOldLayout = (storedPath: string) =>
    legacyDefaultDir &&
    isManagedTaskspaceDirectory({
      workspaceRoot,
      storedPath,
      pathKind: "workspace_relative",
      defaultDir: config.taskspace.defaultDir,
      namespacePaths: [],
      namespaceFolders: legacyFolders,
    });

  const taskspaces = await getAllTaskspaces({ db });
  for (const taskspace of taskspaces) {
    const { id, name, path, pathKind, namespaceId } = taskspace;
    if (!path || pathKind !== "workspace_relative" || !namespaceId) continue;
    // Moving it would carry another taskspace along and break that one's record.
    if (holdsOtherTaskspaces(workspaceRoot, taskspace, taskspaces)) continue;
    let parentDir: string;
    try {
      parentDir = taskspaceParentDir({ ...placement, namespaceId, namespaces, folders });
    } catch (e) {
      // `kozane taskspace create` reports an ambiguous key on its own.
      if (e instanceof AmbiguousNamespacePathError) continue;
      throw e;
    }
    const target = resolve(workspaceRoot, parentDir, basename(path));
    if (!isStrictlyInside(workspaceRoot, target)) continue;
    if (target === resolve(workspaceRoot, path)) continue;
    let claim;
    try {
      claim = taskspaceDirectoryClaim({ workspaceRoot, storedPath: path, taskspaceId: id });
    } catch {
      continue;
    }
    if (claim !== "owned") continue;
    moves.push({
      taskspaceId: id,
      name,
      from: path,
      to: relative(workspaceRoot, target),
      oldLayout: inOldLayout(path),
    });
  }
  return { legacyDefaultDir, moves: withoutNesting(workspaceRoot, moves) };
}

/**
 * Drop moves whose target would sit inside another taskspace's directory, where deleting that
 * taskspace would delete it too. A directory that is itself about to move is no obstacle, such
 * as a legacy taskspace named `taskspaces` at the root: it is moved first, so the folders
 * under it are plain folders by the time the others arrive.
 */
function withoutNesting(workspaceRoot: string, moves: LayoutMove[]): LayoutMove[] {
  const enclosingOf = new Map(
    moves.map((move) => [
      move,
      enclosingTaskspaceDir(workspaceRoot, dirname(resolve(workspaceRoot, move.to))),
    ]),
  );
  // Repeat until nothing changes: dropping a move keeps its directory in place, which can
  // make another move's target nested after all.
  let kept = moves;
  for (;;) {
    const leaving = new Set(kept.map(({ from }) => resolve(workspaceRoot, from)));
    const next = kept.filter((move) => {
      const enclosing = enclosingOf.get(move);
      return enclosing == null || leaving.has(enclosing);
    });
    if (next.length === kept.length) break;
    kept = next;
  }
  // Move a directory that others' targets sit under before those others.
  const enclosesTarget = ({ from }: LayoutMove) =>
    kept.some(({ to }) =>
      isStrictlyInside(resolve(workspaceRoot, from), resolve(workspaceRoot, to)),
    );
  return [...kept.filter(enclosesTarget), ...kept.filter((move) => !enclosesTarget(move))];
}

/** Whether `kozane doctor --fix` has anything to do. */
export function layoutNeedsFix(plan: LayoutPlan): boolean {
  return plan.legacyDefaultDir || plan.moves.length > 0;
}

/**
 * Whether the workspace is still in the old layout: the legacy config, or a directory where
 * it put one. `kozane doctor` fails only on this. Other moves, such as after a namespace was
 * renamed, are a normal result of editing namespaces, and the directories keep working.
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
      const reason = message(e);
      try {
        undo();
        result.failed.push({ move, reason });
      } catch (undoError) {
        result.failed.push({
          move,
          reason:
            `${reason}. Could not move it back (${message(undoError)}), so its record no ` +
            `longer matches the directory; run kozane taskspace scan --apply to update it`,
        });
      }
    }
  }

  if (plan.legacyDefaultDir) {
    const raw = readRawConfig(root);
    if (result.failed.length > 0) {
      result.config = "kept";
    } else if (isPlainObject(raw.taskspace)) {
      raw.taskspace.defaultDir = DEFAULT_TASKSPACE_DIR;
      writeFileAtomic(configPath(root), JSON.stringify(raw, null, 2) + "\n");
      result.config = "updated";
    }
  }
  return result;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Why a move failed, plus what to do when something is in the way. */
function moveFailure(move: LayoutMove, e: unknown): string {
  if (!(e instanceof TaskspaceFilesError && e.reason === "exists")) return message(e);
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
  const undoAside = step(from, aside);
  let undoTarget: () => void;
  try {
    undoTarget = step(aside, to);
  } catch (e) {
    try {
      undoAside();
    } catch (undoError) {
      throw new Error(
        `${message(e)}. Could not move it back from ${aside} (${message(undoError)}); ` +
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

/** Most moves to list before summing up the rest. */
const LISTED_MOVES = 5;

/** One line per move, such as `notes → taskspaces/Work/notes`, capped at a few. */
export function describeMoves(moves: readonly LayoutMove[], indent = "  "): string[] {
  const lines = moves.slice(0, LISTED_MOVES).map(({ from, to }) => `${indent}${from} → ${to}`);
  if (moves.length > LISTED_MOVES) lines.push(`${indent}…and ${moves.length - LISTED_MOVES} more`);
  return lines;
}
