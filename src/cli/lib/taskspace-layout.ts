/**
 * Finding and fixing taskspace directories that are not where Kozane now puts them.
 *
 * Older workspaces put new taskspaces at `<root>/<name>`, and their config says
 * `"defaultDir": "."`. The current layout is `<root>/taskspaces/<namespace>/<name>`. Only
 * directories Kozane created itself (`ownsDirectory: true` in the marker) are moved. Any
 * other directory is the user's and stays where it is.
 *
 * `kozane open` refuses to start while a move is pending, and `kozane doctor --fix` makes it.
 */
import { readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllTaskspaces, updateTaskspace } from "../../db/api/taskspace.js";
import type { DB } from "../../db/tx.js";
import { DEFAULT_TASKSPACE_DIR } from "../../lib/constants.js";
import { isPlainObject } from "../../lib/plain-object.js";
import { writeFileAtomic } from "../../lib/server/atomic-write.js";
import { isStrictlyInside } from "../../lib/server/fs-paths.js";
import {
  isManagedTaskspaceDirectory,
  moveTaskspaceDirectory,
  restoreTaskspaceDirectory,
  taskspaceDirectoryClaim,
} from "../../lib/server/taskspace-directory.js";
import { namespaceFolders, taskspaceParentDir } from "../../lib/server/taskspace-location.js";
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
  configUpdated: boolean;
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
 * Work out which owned taskspace directories are not where the layout puts them. A legacy
 * `defaultDir` counts as `taskspaces`, since `--fix` rewrites it to that.
 *
 * A taskspace is left out when Kozane could not move it anyway: no namespace, a path outside
 * the workspace, a directory it did not create, or a target outside the workspace or under an
 * ambiguous `namespacePaths` key, which `kozane taskspace create` reports on its own.
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
  const legacyFolders = [...namespaceFolders(namespaces).values()];
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

  for (const taskspace of await getAllTaskspaces({ db })) {
    const { id, name, path, pathKind, namespaceId } = taskspace;
    if (!path || pathKind !== "workspace_relative" || !namespaceId) continue;
    let parentDir: string;
    try {
      parentDir = taskspaceParentDir({ ...placement, namespaceId, namespaces });
    } catch {
      continue;
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
  return { legacyDefaultDir, moves };
}

export function layoutNeedsFix(plan: LayoutPlan): boolean {
  return plan.legacyDefaultDir || plan.moves.length > 0;
}

/**
 * Rewrite a legacy `defaultDir` to `taskspaces`, then move each directory and update its
 * record. The config goes first, so a move that fails leaves the moved ones where the config
 * expects them, and running the fix again retries the rest. Other config keys are kept as
 * they are.
 */
export async function applyTaskspaceLayout(
  db: DB,
  root: string,
  plan: LayoutPlan,
): Promise<LayoutResult> {
  const result: LayoutResult = { configUpdated: false, moved: [], failed: [] };
  if (plan.legacyDefaultDir) {
    const raw = readRawConfig(root);
    if (isPlainObject(raw.taskspace)) {
      raw.taskspace.defaultDir = DEFAULT_TASKSPACE_DIR;
      writeFileAtomic(configPath(root), JSON.stringify(raw, null, 2) + "\n");
      result.configUpdated = true;
    }
  }

  const workspaceRoot = resolve(root);
  for (const move of plan.moves) {
    try {
      moveTaskspaceDirectory({
        workspaceRoot,
        storedPath: move.from,
        taskspaceId: move.taskspaceId,
        nextStored: move.to,
      });
    } catch (e) {
      result.failed.push({ move, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    try {
      await updateTaskspace({ db, taskspaceId: move.taskspaceId, path: move.to });
      result.moved.push(move);
    } catch (e) {
      // Put the directory back so the record still points at it.
      restoreTaskspaceDirectory(workspaceRoot, move.to, move.from);
      result.failed.push({ move, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/** Most moves to list before summing up the rest. */
const LISTED_MOVES = 5;

/** One line per move, such as `notes → taskspaces/Work/notes`, capped at a few. */
export function describeMoves(moves: readonly LayoutMove[], indent = "  "): string[] {
  const lines = moves.slice(0, LISTED_MOVES).map(({ from, to }) => `${indent}${from} → ${to}`);
  if (moves.length > LISTED_MOVES) lines.push(`${indent}…and ${moves.length - LISTED_MOVES} more`);
  return lines;
}
