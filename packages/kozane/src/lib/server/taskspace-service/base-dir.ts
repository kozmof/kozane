import type { DB } from "../../../db/database.js";
import { TaskspaceServiceError } from "./errors.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { namespaceTable, taskspaceTable, taskspaceLocalTable } from "../../../db/schema.js";
import { getWorkspaceRoot } from "../../../db/internal/config.js";
import { resolveTaskspacePath } from "../taskspace-path.js";
import { TASKSPACE_FILES_STATUS, TaskspaceFilesError } from "../taskspace-files.js";
import { oneAtATime } from "./queue.js";
import { journalTaskspaceFileChange, TaskspaceFileOperationError } from "./file-operation.js";
import type { TaskspaceFileChange } from "../taskspace-file-operations.js";
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
  if (
    !(await db
      .select({ id: namespaceTable.id })
      .from(namespaceTable)
      .where(eq(namespaceTable.id, namespaceId))
      .get())
  )
    throw new TaskspaceServiceError(404, "Namespace not found");
  const taskspace = await db
    .select({ path: taskspaceLocalTable.path, pathKind: taskspaceLocalTable.pathKind })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id))
    .where(
      and(
        eq(taskspaceTable.id, taskspaceId),
        or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)),
      ),
    )
    .get();
  if (!taskspace) throw new TaskspaceServiceError(404, "Taskspace not found");
  if (!taskspace.path || taskspace.pathKind === null)
    throw new TaskspaceServiceError(404, "Taskspace has no directory");
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
 * {@link oneAtATime}. Capture database context, routing and intent before waiting.
 * Resolve the attachment inside the queue so earlier directory moves are visible.
 * Read and check the request body before calling this, so a slow upload never holds
 * up other changes to the taskspace.
 */
export function queuedFilesChange<T>(
  locals: { db: DB },
  params: {
    namespaceId: string;
    taskspaceId: string;
  },
  whatFailed: string,
  request: TaskspaceFileChange,
  change: (baseDir: string) => T,
): Promise<T> {
  const { db } = locals;
  const { namespaceId, taskspaceId } = params;
  const ownedRequest = Object.freeze({ ...request });
  return oneAtATime(taskspaceId, async () => {
    const baseDir = await taskspaceBaseDir({ db }, namespaceId, taskspaceId);
    try {
      const root = getWorkspaceRoot();
      if (!root)
        throw new TaskspaceServiceError(503, "No Kozane workspace found. Run 'kozane init' first.");
      return await journalTaskspaceFileChange(
        {
          db,
          namespaceId,
          taskspaceId,
          root,
          baseDir,
          request: ownedRequest,
          currentBaseDir: () => taskspaceBaseDir({ db }, namespaceId, taskspaceId),
        },
        change,
      );
    } catch (e) {
      if (e instanceof TaskspaceFileOperationError) {
        if (e.phase === "confirm")
          throw new TaskspaceServiceError(
            500,
            "File change needs recovery. Run 'kozane doctor' before repeating it.",
          );
        if (e.cause instanceof TaskspaceServiceError) throw e.cause;
        rethrowFilesError(e.cause, whatFailed);
      }
      if (e instanceof TaskspaceServiceError) throw e;
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
