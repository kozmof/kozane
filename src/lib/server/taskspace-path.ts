import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PATH_KINDS, type PathKind } from "../constants.js";
import { isStrictlyInside } from "./fs-paths.js";

/**
 * How to store a taskspace directory's path: relative when it is strictly inside the
 * workspace root, else absolute. Whole segments are compared, so `/ws-other` is not taken to
 * be inside `/ws`, and the root itself is stored absolute rather than as an empty path.
 */
export function storedLocation(
  workspaceRoot: string,
  dir: string,
): { pathKind: PathKind; storedPath: string } {
  const base = resolve(workspaceRoot);
  const target = resolve(dir);
  return isStrictlyInside(base, target)
    ? { pathKind: "workspace_relative", storedPath: relative(base, target) }
    : { pathKind: "absolute", storedPath: target };
}

/**
 * Why a stored taskspace path cannot be used, or null when it can. A `workspace_relative`
 * path must stay inside the workspace root, and an `absolute` path must be absolute.
 *
 * Only `kozane taskspace create --dir` and `kozane taskspace scan` store absolute paths, and
 * `kozane db import` refuses them without `--allow-absolute-paths`. This check runs on every
 * read so a row written by hand or by an older import cannot reach outside the root by
 * using `..` in a relative path.
 */
export function taskspacePathIssue(storedPath: string, pathKind: string): string | null {
  if (!(PATH_KINDS as readonly string[]).includes(pathKind))
    return `unknown path kind "${pathKind}"`;
  if (storedPath.includes("\0")) return "path contains a NUL byte";
  if (pathKind === "absolute")
    return isAbsolute(storedPath) ? null : "absolute path is not absolute";
  if (isAbsolute(storedPath)) return "workspace-relative path is absolute";
  // Compare whole segments of the normalized path, so `..notes` is a name and not a parent.
  const rel = relative("/root", join("/root", storedPath));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return "workspace-relative path leaves the workspace";
  return null;
}

/**
 * Resolve stored taskspace paths on the server. Interpret `workspace_relative` paths against
 * the workspace root and use absolute paths unchanged. Return null for a path that
 * {@link taskspacePathIssue} refuses, so callers treat it like a taskspace with no directory.
 */
export function resolveTaskspacePath(
  storedPath: string,
  pathKind: PathKind,
  workspaceRoot: string,
): string | null {
  if (taskspacePathIssue(storedPath, pathKind)) return null;
  return pathKind === "absolute" ? storedPath : join(workspaceRoot, storedPath);
}
