import { error } from "@sveltejs/kit";
import { getNamespace } from "$db/api/namespace";
import { getTaskspaceInNamespace } from "$db/api/taskspace";
import { getWorkspaceRoot } from "$db/internal/config";
import { resolveTaskspacePath } from "$lib/server/taskspace-path";
import { TASKSPACE_FILES_STATUS, TaskspaceFilesError } from "$lib/server/taskspace-files";

/**
 * Resolve the request's trusted taskspace root from its database record and workspace root.
 * Require a taskspace visible in the requested namespace.
 *
 * Share this resolver between file and directory routes. The filesystem helpers enforce
 * containment within the resolved root.
 */
export async function taskspaceBaseDir(
  locals: App.Locals,
  namespaceId: string,
  taskspaceId: string,
): Promise<string> {
  const { db } = locals;

  if (!(await getNamespace({ db, namespaceId }))) throw error(404, "Namespace not found");

  const taskspace = await getTaskspaceInNamespace({ db, namespaceId, taskspaceId });
  if (!taskspace) throw error(404, "Taskspace not found");
  if (!taskspace.path) throw error(404, "Taskspace has no directory");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  return resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
}

/**
 * Turns a refusal from `taskspace-files.ts` into the status it means, and anything else
 * into a 500 with the reason logged rather than sent.
 */
export function rethrowFilesError(e: unknown, whatFailed: string): never {
  if (e instanceof TaskspaceFilesError) throw error(TASKSPACE_FILES_STATUS[e.reason], e.message);
  console.error(`${whatFailed}:`, e);
  throw error(500, whatFailed);
}
