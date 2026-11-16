/**
 * Find and move taskspace directories outside the configured layout.
 *
 * Older workspaces put new taskspaces at `<root>/<name>`, and their config says
 * `"defaultDir": "."`. The default layout is now `<root>/taskspaces/<namespace>/<name>`. Only
 * directories Kozane created itself (`ownsDirectory: true` in the marker) are moved. Any
 * other directory is the user's and stays where it is.
 *
 * `kozane open` refuses to start while a move out of the old layout is pending, and
 * `kozane doctor --fix` moves the directories. Other moves, such as after a namespace
 * rename, are reported by `kozane doctor` and applied with `--fix` without blocking open.
 */
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllTaskspaces } from "../../db/api/taskspace.js";
import type { DB } from "../../db/tx.js";
import { DEFAULT_TASKSPACE_DIR } from "../../lib/constants.js";
import { errorMessage } from "../../lib/error-message.js";
import { isPlainObject } from "../../lib/plain-object.js";
import { writeFileAtomic } from "../../lib/server/atomic-write.js";
import { isStrictlyInside, isWithin, sameEntry } from "../../lib/server/fs-paths.js";
import { TaskspaceFilesError } from "../../lib/server/taskspace-files.js";
import {
  enclosingTaskspaceDirs,
  holdsOtherTaskspaces,
  isManagedTaskspaceDirectory,
  taskspaceDirectoryClaim,
} from "../../lib/server/taskspace-directory.js";
import {
  AmbiguousNamespacePathError,
  folderKey,
  namespaceFolders,
  taskspaceParentDir,
} from "../../lib/taskspace-location.js";
import { CONFIG_FILE, KOZANE_DIR, type WorkspaceConfig } from "./config.js";
import { applyLayoutMove } from "./taskspace-layout-operation.js";
import { LocalOperationError } from "../../lib/server/taskspace-service/journal-operation.js";
import { localFileOperationTable } from "../../db/schema.js";
import { eq } from "drizzle-orm";

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
  /** An earlier operation requires inspection before any layout work can start. */
  blocked?: string;
  /**
   * `updated`: the legacy `defaultDir` was rewritten. `kept`: it was left because a move
   * failed or pending work needs review. `unchanged`: the config was not legacy, or
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
 * The config changes only when every move succeeded. Interrupted work remains pending
 * for inspection. A later invocation leaves it alone until the operator resolves or
 * explicitly abandons its tracking record. Confirmed moves already count as in place.
 */
export async function applyTaskspaceLayout(
  db: DB,
  root: string,
  plan: LayoutPlan,
): Promise<LayoutResult> {
  const result: LayoutResult = { config: "unchanged", moved: [], failed: [] };
  const workspaceRoot = resolve(root);
  const pending = await db
    .select({ id: localFileOperationTable.id })
    .from(localFileOperationTable)
    .where(eq(localFileOperationTable.state, "pending"))
    .limit(5);
  if (pending.length) {
    result.blocked = `Inspect pending local filesystem operations (${pending.map(({ id }) => id).join(", ")}) before changing the layout`;
    result.failed = plan.moves.map((move) => ({ move, reason: result.blocked! }));
    if (plan.legacyDefaultDir) result.config = "kept";
    return result;
  }
  const pendingOwnedByBatch = new Set<string>();
  for (const move of plan.moves) {
    const dependency = result.failed.find(({ move: failed }) =>
      isWithin(resolve(workspaceRoot, failed.from), resolve(workspaceRoot, move.to)),
    );
    if (dependency) {
      const failedFrom = resolve(workspaceRoot, dependency.move.from);
      result.failed.push({
        move,
        reason: isStrictlyInside(failedFrom, resolve(workspaceRoot, move.to))
          ? `its target would be inside the taskspace at ${relative(workspaceRoot, failedFrom)}, whose move did not finish`
          : `its target depends on the unfinished move from ${relative(workspaceRoot, failedFrom)}`,
      });
      continue;
    }
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
    try {
      await applyLayoutMove(db, workspaceRoot, move, pendingOwnedByBatch);
      result.moved.push(move);
    } catch (e) {
      if (e instanceof LocalOperationError) pendingOwnedByBatch.add(e.operationId);
      result.failed.push({
        move,
        reason:
          e instanceof LocalOperationError
            ? `${errorMessage(e.cause)}. Layout move needs recovery (${e.operationId}); inspect it with kozane doctor before repeating changes`
            : moveFailure(move, e),
      });
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
