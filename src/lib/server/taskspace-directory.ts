import { lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PathKind } from "../constants.js";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import { errorCode, isStrictlyInside } from "./fs-paths.js";
import { TaskspaceFilesError } from "./taskspace-files.js";

/**
 * Renaming and deleting a taskspace's own directory from the browser.
 *
 * Only a directory Kozane made itself is touched. Its path is stored relative to the
 * workspace and sits directly in the configured `taskspace.defaultDir`, and its
 * `.taskspace.json` names the taskspace and says `ownsDirectory: true`. The path alone is not
 * enough: `defaultDir` is `.` unless configured, so `kozane taskspace create --dir src` would
 * otherwise put the user's own `src` in reach. Any other directory belongs to the user, so
 * renaming changes only the label and deleting keeps the directory.
 */

type ManagedCheck = {
  workspaceRoot: string;
  storedPath: string | null;
  pathKind: PathKind;
  /** `taskspace.defaultDir` from the workspace config, relative to the root or absolute. */
  defaultDir: string;
};

/**
 * Whether the stored path is where Kozane creates taskspaces. A first check only. The
 * directory's marker decides, see {@link taskspaceDirectoryClaim}.
 *
 * Both sides are resolved against the root, so `tasks/`, `./tasks`, and an absolute path to
 * the same directory all match, as they do when the CLI creates the taskspace.
 */
export function isManagedTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  pathKind,
  defaultDir,
}: ManagedCheck): boolean {
  if (!storedPath || pathKind !== "workspace_relative") return false;
  return dirname(resolve(workspaceRoot, storedPath)) === resolve(workspaceRoot, defaultDir);
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

/**
 * What a taskspace's directory says about who owns it:
 * - `owned`: its marker names this taskspace and says Kozane made the directory.
 * - `adopted`: its marker names this taskspace, but the directory was the user's.
 * - `foreign`: no readable marker, or one naming another taskspace.
 * - `missing`: nothing is at the path.
 */
export type DirectoryClaim = "owned" | "adopted" | "foreign" | "missing";

function readClaim(dir: string, taskspaceId: string): Exclude<DirectoryClaim, "missing"> {
  let marker;
  try {
    marker = JSON.parse(readFileSync(join(dir, TASKSPACE_MARKER_FILE), "utf-8"));
  } catch {
    return "foreign";
  }
  if (marker?.kind !== TASKSPACE_MARKER_KIND || marker?.taskspaceId !== taskspaceId)
    return "foreign";
  return marker.ownsDirectory === true ? "owned" : "adopted";
}

type DirectoryTarget = {
  workspaceRoot: string;
  storedPath: string;
  taskspaceId: string;
};

/** Read who owns a taskspace's directory. See {@link DirectoryClaim}. */
export function taskspaceDirectoryClaim({
  workspaceRoot,
  storedPath,
  taskspaceId,
}: DirectoryTarget): DirectoryClaim {
  const dir = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(dir, workspaceRoot)) return "missing";
  return readClaim(dir, taskspaceId);
}

/**
 * Move an owned taskspace directory to `newName` beside it. Return the new stored path. Never
 * replaces an existing entry that was there when checked.
 *
 * Node has no rename that refuses to replace its target, so another process that creates
 * `newName` between the check and the move can still lose an empty directory to it. A
 * nonempty one makes the move fail instead.
 */
export function renameTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  taskspaceId,
  newName,
}: DirectoryTarget & { newName: string }): string {
  const from = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(from, workspaceRoot))
    throw new TaskspaceFilesError("not-found", "Taskspace directory not found");
  if (readClaim(from, taskspaceId) !== "owned")
    throw new TaskspaceFilesError("forbidden", "Kozane did not create this directory");

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

  try {
    renameSync(from, to);
  } catch (e) {
    const code = errorCode(e);
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR")
      throw new TaskspaceFilesError("exists", "A directory with that name already exists");
    throw e;
  }
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
 * Delete an owned taskspace directory and everything in it. Check the marker again right
 * before deleting, so a directory that took the path over is never removed. Return whether
 * there was anything to delete.
 */
export function removeTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  taskspaceId,
}: DirectoryTarget): "deleted" | "missing" {
  const dir = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(dir, workspaceRoot)) return "missing";
  if (readClaim(dir, taskspaceId) !== "owned")
    throw new TaskspaceFilesError(
      "exists",
      "The directory's .taskspace.json does not name this taskspace, so it was not deleted",
    );
  // `rm` removes symlinks inside the tree without following them.
  rmSync(dir, { recursive: true });
  return "deleted";
}
