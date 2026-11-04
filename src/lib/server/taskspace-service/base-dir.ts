import type { DB } from "../../../db/database.js";
import { TaskspaceServiceError } from "./errors.js";
import { getNamespace } from "../../../db/api/namespace.js";
import { getTaskspaceInNamespace } from "../../../db/api/taskspace.js";
import { getWorkspaceRoot } from "../../../db/internal/config.js";
import { resolveTaskspacePath } from "../../server/taskspace-path.js";
import { TASKSPACE_FILES_STATUS, TaskspaceFilesError } from "../../server/taskspace-files.js";
import { oneAtATime } from "./queue.js";
/**
 * Resolve the request's trusted taskspace root from its database record and workspace root.
 * Require a taskspace visible in the requested namespace.
 *
 * Share this resolver between file and directory routes. The filesystem helpers enforce
 * containment within the resolved root.
 */
export async function taskspaceBaseDir(
  locals: { db: DB },
  namespaceId: string,
  taskspaceId: string,
): Promise<string> {
  const { db } = locals;
  if (!(await getNamespace({ db, namespaceId })))
    throw new TaskspaceServiceError(404, "Namespace not found");
  const taskspace = await getTaskspaceInNamespace({ db, namespaceId, taskspaceId });
  if (!taskspace) throw new TaskspaceServiceError(404, "Taskspace not found");
  if (!taskspace.path) throw new TaskspaceServiceError(404, "Taskspace has no directory");
  const root = getWorkspaceRoot();
  if (!root)
    throw new TaskspaceServiceError(503, "No Kozane workspace found. Run 'kozane init' first.");
  const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
  // A stored path that would leave the workspace, such as `../elsewhere`, is not served.
  if (!baseDir) throw new TaskspaceServiceError(404, "Taskspace directory is not valid");
  return baseDir;
}
/**
 * Change a taskspace's files after every earlier change to it has finished, see
 * {@link oneAtATime}. The directory is resolved inside the queue, so it reflects any rename
 * before it. Read and check the request body before calling this, so a slow upload never
 * holds up other changes to the taskspace.
 */
export function queuedFilesChange<T>(
  locals: { db: DB },
  params: {
    namespaceId: string;
    taskspaceId: string;
  },
  whatFailed: string,
  change: (baseDir: string) => T,
): Promise<T> {
  return oneAtATime(params.taskspaceId, async () => {
    const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
    try {
      return change(baseDir);
    } catch (e) {
      rethrowFilesError(e, whatFailed);
    }
  });
}
/**
 * Map taskspace file errors to their HTTP status. Log unexpected errors and return 500
 * without exposing the cause in the response.
 */
export function rethrowFilesError(e: unknown, whatFailed: string): never {
  if (e instanceof TaskspaceFilesError)
    throw new TaskspaceServiceError(TASKSPACE_FILES_STATUS[e.reason], e.message);
  console.error(`${whatFailed}:`, e);
  throw new TaskspaceServiceError(500, whatFailed);
}
