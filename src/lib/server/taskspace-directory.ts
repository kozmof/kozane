import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PathKind } from "../constants.js";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import type { TaskspaceDirectoryOutcome } from "../types.js";
import { errorCode, isStrictlyInside, isWithin, sameEntry } from "./fs-paths.js";
import { TaskspaceFilesError } from "./taskspace-files.js";

/**
 * Renaming and deleting a taskspace's own directory from the browser.
 *
 * Only a directory Kozane made itself is touched. Its path is stored relative to the
 * workspace and sits where Kozane creates taskspaces: in `taskspace.defaultDir`, directly or
 * in a current namespace's folder there, or directly in a `taskspace.namespacePaths` directory. Its
 * `.taskspace.json` names the taskspace and says `ownsDirectory: true`. The path alone is
 * not enough: `defaultDir` can be set to `.`, so `kozane taskspace create --dir src` would
 * otherwise put the user's own `src` in reach. Any other directory belongs to the user, so
 * renaming changes only the label and deleting keeps the directory.
 */

type ManagedCheck = {
  workspaceRoot: string;
  storedPath: string | null;
  pathKind: PathKind;
  /** `taskspace.defaultDir` from the workspace config, relative to the root or absolute. */
  defaultDir: string;
  /** The directories in `taskspace.namespacePaths`, without the namespaces they belong to. */
  namespacePathDirs: readonly string[];
  /** Every current namespace's folder name, as `namespaceFolders()` in taskspace-location.ts gives it. */
  namespaceFolders: readonly string[];
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
  namespacePathDirs,
  namespaceFolders,
}: ManagedCheck): boolean {
  if (!storedPath || pathKind !== "workspace_relative") return false;
  const parent = dirname(resolve(workspaceRoot, storedPath));
  const base = resolve(workspaceRoot, defaultDir);
  // Directly in `defaultDir`, or in a current namespace's folder inside it. Both are accepted
  // whatever `taskspace.namespaceDirs` says now, so turning it on or off keeps directories
  // made earlier manageable. Any other folder is refused: with `defaultDir` set to `.`,
  // accepting every grandchild would put the user's own `src/lib` in reach. A namespace that
  // was renamed leaves its old folder unmanaged, which only means rename and delete stop
  // touching that directory. Folder names are compared ignoring case, as `namespaceFolders()`
  // keeps them apart, so renaming "Work" to "work" on a case-insensitive disk, where both
  // name the same folder, keeps its directories managed. The marker still decides ownership.
  if (parent === base) return true;
  const folder = basename(parent).toLowerCase();
  if (dirname(parent) === base && namespaceFolders.some((f) => f.toLowerCase() === folder))
    return true;
  // Any configured namespace path is accepted, not only the one for this taskspace's
  // namespace, so moving a taskspace to another namespace keeps it manageable.
  return namespacePathDirs.some((dir) => parent === resolve(workspaceRoot, dir));
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
      "Taskspace directory cannot be the workspace's .kozane settings",
    );
  return true;
}

/**
 * What a taskspace's directory says about who owns it:
 * - `owned`: its marker names this taskspace and says Kozane made the directory.
 * - `adopted`: its marker names this taskspace, but the directory was the user's.
 * - `foreign`: no readable marker, or one naming another taskspace.
 * - `unmanaged`: something Kozane never makes is at the path, such as a symlink, a file, or
 *   a directory that resolves outside the workspace. It is left alone, as `adopted` is.
 * - `missing`: nothing is at the path.
 */
export type DirectoryClaim = "owned" | "adopted" | "foreign" | "unmanaged" | "missing";

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
  try {
    if (!assertOwnDirectory(dir, workspaceRoot)) return "missing";
  } catch (e) {
    // Not a directory Kozane could have made, so it is the user's to keep.
    if (e instanceof TaskspaceFilesError && e.reason === "invalid-path") return "unmanaged";
    throw e;
  }
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
  newName,
  ...target
}: DirectoryTarget & { newName: string }): string {
  return moveTaskspaceDirectory({
    ...target,
    nextStored: join(dirname(target.storedPath), newName),
  });
}

/**
 * Move an owned taskspace directory to `nextStored`, a path relative to the workspace,
 * creating the folders above it. Return `nextStored`. The same rules as
 * {@link renameTaskspaceDirectory} apply: only an owned directory moves, it stays inside the
 * workspace, and an existing entry at the target is never replaced.
 */
export function moveTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  taskspaceId,
  nextStored,
}: DirectoryTarget & { nextStored: string }): string {
  const from = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(from, workspaceRoot))
    throw new TaskspaceFilesError("not-found", "Taskspace directory not found");
  if (readClaim(from, taskspaceId) !== "owned")
    throw new TaskspaceFilesError("forbidden", "Kozane did not create this directory");

  const to = resolve(workspaceRoot, nextStored);
  const outside = () =>
    new TaskspaceFilesError("invalid-path", "Taskspace path must be inside the workspace root");
  if (!isStrictlyInside(resolve(workspaceRoot), to)) throw outside();
  const created = makeParentsInside(workspaceRoot, dirname(to));
  if (!created) throw outside();

  try {
    try {
      const existing = lstatSync(to);
      // A case-only rename on a case-insensitive disk finds the directory itself.
      if (!sameEntry(existing, lstatSync(from)))
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
  } catch (e) {
    removeEmptyDirs(created);
    throw e;
  }
  return nextStored;
}

/**
 * The nearest folder at or above `dir`, strictly inside the workspace, that holds a taskspace
 * marker, or null when there is none. Kozane checks this before placing a new taskspace, so it
 * never puts one inside another taskspace's directory, where deleting the outer taskspace
 * would delete it too. Paths are compared as text, and missing folders are skipped.
 */
export function enclosingTaskspaceDir(workspaceRoot: string, dir: string): string | null {
  return enclosingTaskspaceDirs(workspaceRoot, dir)[0] ?? null;
}

/**
 * Every folder at or above `dir`, strictly inside the workspace, that holds a taskspace
 * marker, nearest first. {@link enclosingTaskspaceDir} is enough to refuse a target. This is
 * for callers that excuse some of them, such as a taskspace that is about to move away: one
 * further up that stays still encloses the target.
 */
export function enclosingTaskspaceDirs(workspaceRoot: string, dir: string): string[] {
  const root = resolve(workspaceRoot);
  const found: string[] = [];
  for (let current = resolve(dir); isStrictlyInside(root, current); current = dirname(current)) {
    try {
      lstatSync(join(current, TASKSPACE_MARKER_FILE));
      found.push(current);
    } catch (e) {
      const code = errorCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
  }
  return found;
}

/** A taskspace record's stored path, as {@link holdsOtherTaskspaces} reads it. */
export type StoredTaskspacePath = { id: string; path: string | null; pathKind: PathKind };

/**
 * Whether another taskspace's directory sits inside this one's. Moving or deleting the outer
 * directory would then break or delete the inner taskspace, so Kozane leaves it where it is.
 */
export function holdsOtherTaskspaces(
  workspaceRoot: string,
  taskspace: StoredTaskspacePath,
  all: readonly StoredTaskspacePath[],
): boolean {
  if (!taskspace.path) return false;
  const dir = resolve(workspaceRoot, taskspace.path);
  return all.some(
    ({ id, path }) =>
      id !== taskspace.id && !!path && isStrictlyInside(dir, resolve(workspaceRoot, path)),
  );
}

/**
 * The recorded taskspace whose directory `dir` would sit strictly inside, as an absolute path,
 * or null. {@link enclosingTaskspaceDir} only looks inside the workspace, so this covers a
 * target outside it, such as an absolute `taskspace.defaultDir`. It reads the records rather
 * than walking up the disk, so it never mistakes an unrelated folder above the workspace for
 * a taskspace.
 */
export function enclosingRecordedTaskspace(
  workspaceRoot: string,
  dir: string,
  all: readonly StoredTaskspacePath[],
): string | null {
  const target = resolve(dir);
  for (const { path } of all) {
    if (!path) continue;
    // `resolve` keeps an absolute stored path as it is.
    const taskspaceDir = resolve(workspaceRoot, path);
    if (isStrictlyInside(taskspaceDir, target)) return taskspaceDir;
  }
  return null;
}

/**
 * The directories missing on the way to `dir`, deepest first. Stops at the first entry that
 * exists, including a dangling symlink, which {@link makeParentsInside} then refuses.
 */
export function missingDirs(dir: string): string[] {
  const missing: string[] = [];
  for (let current = resolve(dir); ; current = dirname(current)) {
    try {
      lstatSync(current);
      return missing;
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    missing.push(current);
    if (dirname(current) === current) return missing;
  }
}

/**
 * Create `dir` and the folders above it, but only when it really sits inside the workspace.
 * Return the directories made, deepest first, or null when `dir` is outside or a parent is a
 * dangling symlink.
 *
 * The textual containment check cannot see symlinks. A parent such as
 * `taskspaces -> /elsewhere` would put the directory outside the workspace, so the nearest
 * existing ancestor is resolved first, and nothing is created when it lies outside.
 */
export function makeParentsInside(workspaceRoot: string, dir: string): string[] | null {
  const created = missingDirs(dir);
  const existing = created.length > 0 ? dirname(created[created.length - 1]) : resolve(dir);
  const realRoot = realpathSync(workspaceRoot);
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch (e) {
    // A dangling symlink, or a loop of them, leads nowhere inside the workspace.
    const code = errorCode(e);
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw e;
  }
  if (!isWithin(realRoot, realExisting)) return null;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // Take back the folders made before the failure.
    removeEmptyDirs(created);
    throw e;
  }
  // Checked again in case the path changed while the folders were made. A folder that was
  // removed or swapped for a dangling symlink meanwhile cannot be shown to be inside.
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (e) {
    const code = errorCode(e);
    if (code !== "ENOENT" && code !== "ELOOP") throw e;
    removeEmptyDirs(created);
    return null;
  }
  if (!isWithin(realRoot, realDir)) {
    removeEmptyDirs(created);
    return null;
  }
  return created;
}

/** Remove directories made by {@link makeParentsInside}, deepest first, while they are empty. */
export function removeEmptyDirs(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {
      // Something was put there meanwhile, so it and everything above it stay.
      return;
    }
  }
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
 *
 * The marker goes last. A delete that stops partway, such as on a file it may not remove,
 * leaves the marker in place, so the directory is still recognized and the delete can be
 * retried.
 */
export function removeTaskspaceDirectory({
  workspaceRoot,
  storedPath,
  taskspaceId,
}: DirectoryTarget): Extract<TaskspaceDirectoryOutcome, "deleted" | "missing"> {
  const dir = resolve(workspaceRoot, storedPath);
  if (!assertOwnDirectory(dir, workspaceRoot)) return "missing";
  const checked = lstatSync(dir);
  if (readClaim(dir, taskspaceId) !== "owned")
    throw new TaskspaceFilesError(
      "exists",
      "The directory's .taskspace.json does not name this taskspace, so it was not deleted. " +
        `Move the directory aside or restore its .taskspace.json (taskspace ID ${taskspaceId}), then delete again.`,
    );
  /**
   * Stop when the path no longer holds the directory checked above. If another process
   * swapped in a symlink, `join(dir, name)` would follow it out of the workspace. Node has
   * no `unlinkat`, so this narrows that window rather than closing it.
   */
  const stillChecked = () => {
    const now = lstatSync(dir);
    if (now.isSymbolicLink() || !sameEntry(now, checked))
      throw new TaskspaceFilesError("invalid-path", "Taskspace directory changed while deleting");
  };
  // `rm` removes symlinks inside the tree without following them.
  for (const name of readdirSync(dir)) {
    if (name === TASKSPACE_MARKER_FILE) continue;
    stillChecked();
    rmSync(join(dir, name), { recursive: true });
  }
  stillChecked();
  rmSync(join(dir, TASKSPACE_MARKER_FILE), { force: true });
  rmdirSync(dir);
  return "deleted";
}
