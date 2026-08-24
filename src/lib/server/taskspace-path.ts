import { join } from "node:path";
import type { PathKind } from "../constants.js";

/**
 * Where a taskspace record points on disk. A `project_relative` path is stored relative to
 * the workspace root so a workspace stays portable; an `absolute` one comes from
 * `kozane taskspace create --dir <outside-root>` and is used as it stands.
 *
 * Shared rather than CLI-local because the browser UI resolves the same record when it
 * lists a taskspace's files, and a route must not import from `src/cli`. Under
 * `lib/server` rather than beside the isomorphic modules a directory up because it reaches
 * for `node:path`: nothing here can be bundled for a browser, and the directory is what
 * says so.
 */
export function resolveTaskspacePath(
  storedPath: string,
  pathKind: PathKind,
  projectRoot: string,
): string {
  return pathKind === "absolute" ? storedPath : join(projectRoot, storedPath);
}
