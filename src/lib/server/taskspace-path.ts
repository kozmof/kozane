import { join } from "node:path";
import type { PathKind } from "../constants.js";

/**
 * Resolve stored taskspace paths on the server. Interpret `workspace_relative` paths against
 * the workspace root and use absolute paths unchanged.
 */
export function resolveTaskspacePath(
  storedPath: string,
  pathKind: PathKind,
  workspaceRoot: string,
): string {
  return pathKind === "absolute" ? storedPath : join(workspaceRoot, storedPath);
}
