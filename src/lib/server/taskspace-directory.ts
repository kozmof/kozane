import { lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { PathKind } from "../constants.js";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import { TaskspaceFilesError } from "./taskspace-files.js";

/**
 * Renaming and deleting a taskspace's own directory from the browser.
 *
 * Only a managed directory is touched: one stored relative to the workspace, sitting directly
 * in the configured `taskspace.defaultDir`, which is where the browser creates taskspaces.
 * A directory chosen with `kozane taskspace create --dir` elsewhere belongs to the user, so
 * renaming changes only the label and deleting keeps the directory.
 */

/** True when `child` sits strictly underneath `parent`. */
function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

type ManagedCheck = {
  storedPath: string | null;
  pathKind: PathKind;
  /** `taskspace.defaultDir` from the workspace config, relative to the root. */
  defaultDir: string;
};

/** Whether the browser may rename or delete this taskspace's directory on disk. */
export function isManagedTaskspaceDirectory({
  storedPath,
  pathKind,
  defaultDir,
}: ManagedCheck): boolean {
  if (!storedPath || pathKind !== "workspace_relative") return false;
  return normalize(dirname(storedPath)) === normalize(defaultDir);
}

function errorCode(e: unknown): unknown {
  return e && typeof e === "object" && "code" in e ? e.code : undefined;
}

/**
 * Check that `dir` is a real directory (not a symlink) strictly inside the workspace root,
 * after resolving symlinks in its parents. Return false when nothing is there.
 */
function assertOwnDirectory(dir: string, workspaceRoot: string): boolean {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    throw e;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new TaskspaceFilesError("invalid-path", "Taskspace path is not a plain directory");
  const realRoot = realpathSync(workspaceRoot);
  const real = realpathSync(dir);
  if (!isStrictlyInside(realRoot, real))
    throw new TaskspaceFilesError(
      "invalid-path",
      "Taskspace directory must be inside the workspace",
    );
  // Never take the workspace's own settings with it.
  if (real === join(realRoot, ".kozane") || isStrictlyInside(join(realRoot, ".kozane"), real))
    throw new TaskspaceFilesError(
      "invalid-path",
      "Taskspace directory must be inside the workspace",
    );
  return true;
}

/** Whether the directory's `.taskspace.json` names this taskspace. */
function hasOwnMarker(dir: string, taskspaceId: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(dir, TASKSPACE_MARKER_FILE), "utf-8"));
    return marker?.kind === TASKSPACE_MARKER_KIND && marker?.taskspaceId === taskspaceId;
  } catch {
    return false;
  }
}

/**
 * Move a managed taskspace directory to `newName` beside it. Return the new stored path. Never
 * replaces an existing entry.
 */
export function renameTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  newName,
}: {
  workspaceRoot: string;
  storedPath: string;
  newName: string;
}): string {
  const from = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(from, workspaceRoot))
    throw new TaskspaceFilesError("not-found", "Taskspace directory not found");

  const nextStored = join(dirname(storedPath), newName);
  const to = resolve(workspaceRoot, nextStored);
  if (!isStrictlyInside(resolve(workspaceRoot), to))
    throw new TaskspaceFilesError(
      "invalid-path",
      "Taskspace path must be inside the workspace root",
    );

  try {
    const existing = lstatSync(to);
    const source = lstatSync(from);
    // A case-only rename on a case-insensitive disk finds the directory itself.
    if (existing.ino !== source.ino || existing.dev !== source.dev)
      throw new TaskspaceFilesError("exists", "A directory with that name already exists");
  } catch (e) {
    if (e instanceof TaskspaceFilesError) throw e;
    if (errorCode(e) !== "ENOENT") throw e;
  }

  renameSync(from, to);
  return nextStored;
}

/** Undo {@link renameTaskspaceDirectory} after a failed database update. */
export function restoreTaskspaceDirectory(
  workspaceRoot: string,
  renamedTo: string,
  originalPath: string,
): void {
  renameSync(resolve(workspaceRoot, renamedTo), resolve(workspaceRoot, originalPath));
}

/**
 * Delete a managed taskspace directory and everything in it. Require the directory's marker
 * to name this taskspace, so a directory that took the path over is never removed. Return
 * whether there was anything to delete.
 */
export function removeTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  taskspaceId,
}: {
  workspaceRoot: string;
  storedPath: string;
  taskspaceId: string;
}): "deleted" | "missing" {
  const dir = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(dir, workspaceRoot)) return "missing";
  if (!hasOwnMarker(dir, taskspaceId))
    throw new TaskspaceFilesError(
      "exists",
      "The directory's .taskspace.json does not name this taskspace, so it was not deleted",
    );
  // `rm` removes symlinks inside the tree without following them.
  rmSync(dir, { recursive: true });
  return "deleted";
}
