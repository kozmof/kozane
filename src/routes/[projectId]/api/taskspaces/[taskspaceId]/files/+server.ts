import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getProject } from "../../../../../../db/api/project";
import { getTaskspace } from "../../../../../../db/api/taskspace";
import { getWorkspaceRoot } from "../../../../../../db/internal/config";
import { resolveTaskspacePath } from "$lib/taskspace-path";
import {
  listTaskspaceDirectory,
  TaskspaceFilesError,
  type TaskspaceFilesReason,
} from "$lib/server/taskspace-files";

const STATUS: Record<TaskspaceFilesReason, number> = {
  "invalid-path": 400,
  forbidden: 403,
  "not-found": 404,
};

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

  // Deliberately not filtered by projectId: taskspaces are cross-project (see the note in
  // db/api/taskspace.ts), and the panel lists every taskspace of the active scope whatever
  // project it was created from. Scoping here would blank out rows the panel still draws.
  const taskspace = await getTaskspace({ db, taskspaceId: params.taskspaceId });
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
    if (e instanceof TaskspaceFilesError) throw error(STATUS[e.reason], e.message);
    console.error("Failed to list taskspace directory:", e);
    throw error(500, "Failed to list taskspace directory");
  }
};
