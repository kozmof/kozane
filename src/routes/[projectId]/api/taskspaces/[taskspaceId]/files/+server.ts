import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getProject } from "$db/api/project";
import { getTaskspaceInProject } from "$db/api/taskspace";
import { getWorkspaceRoot } from "$db/internal/config";
import { resolveTaskspacePath } from "$lib/server/taskspace-path";
import {
  listTaskspaceDirectory,
  TASKSPACE_FILES_STATUS,
  TaskspaceFilesError,
} from "$lib/server/taskspace-files";

/**
 * One directory of a taskspace, for the tree the scope panel draws. The panel asks per
 * directory as folders are opened rather than for a whole tree at once, so a taskspace
 * that happens to contain a checkout costs one small answer per folder actually looked at.
 *
 * Names and metadata only. There is no endpoint that returns the contents of a file.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const { db } = locals;

  if (!(await getProject({ db, projectId: params.projectId })))
    throw error(404, "Project not found");

  // Looked up under the same filter the board draws with — this project's taskspaces and
  // the unassigned ones — so the panel and the endpoints behind it answer about one set.
  // What keeps a request inside a directory is the boundary `listTaskspaceDirectory` holds
  // below, which stands however the row was found; this is about the endpoint not quietly
  // reaching further than the project it is addressed to.
  const taskspace = await getTaskspaceInProject({
    db,
    projectId: params.projectId,
    taskspaceId: params.taskspaceId,
  });
  if (!taskspace) throw error(404, "Taskspace not found");
  if (!taskspace.path) throw error(404, "Taskspace has no directory");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  // The base comes from the record and the workspace root alone. The request chooses only
  // where to look within it, and `listTaskspaceDirectory` is what holds it to that.
  const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);

  try {
    return json(listTaskspaceDirectory({ baseDir, subPath: url.searchParams.get("path") ?? "" }));
  } catch (e) {
    if (e instanceof TaskspaceFilesError) throw error(TASKSPACE_FILES_STATUS[e.reason], e.message);
    console.error("Failed to list taskspace directory:", e);
    throw error(500, "Failed to list taskspace directory");
  }
};
