import { error } from "@sveltejs/kit";
import { getNamespace } from "$db/api/namespace";
import { getTaskspaceInNamespace } from "$db/api/taskspace";
import { getWorkspaceRoot } from "$db/internal/config";
import { resolveTaskspacePath } from "$lib/server/taskspace-path";
import { TASKSPACE_FILES_STATUS, TaskspaceFilesError } from "$lib/server/taskspace-files";

/**
 * The taskspace directory one request is confined to, resolved from the record and the
 * workspace root alone. The request chooses only where to look within it, and the
 * functions in `taskspace-files.ts` are what hold it to that.
 *
 * The row is fetched through `getTaskspaceInNamespace`, so a namespace's endpoint answers only
 * about the taskspaces that namespace's board draws. That is not what keeps a request inside
 * a directory — those functions hold that boundary however the row was found — but every
 * other namespace-scoped endpoint here refuses a row belonging to another namespace, and
 * being the one that does not is a difference nothing gains from.
 *
 * Shared by the `file` and `files` routes rather than written out in each. They resolved the
 * same base by the same rules before this existed, and the comment in one of them said so;
 * two endpoints onto one directory should not be able to drift apart on which directory it is.
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
