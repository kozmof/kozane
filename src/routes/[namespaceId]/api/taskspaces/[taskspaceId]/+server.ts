import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteTaskspace, getTaskspaceInNamespace, updateTaskspace } from "$db/api/taskspace";
import { getNamespace } from "$db/api/namespace";
import { getTaskspaceDefaultDir, getWorkspaceRoot } from "$db/internal/config";
import { taskspaceNameIssue, type PathKind } from "$lib/constants";
import { taskspacePathIssue } from "$lib/server/taskspace-path";
import {
  isManagedTaskspaceDirectory,
  removeTaskspaceDirectory,
  renameTaskspaceDirectory,
  restoreTaskspaceDirectory,
  taskspaceDirectoryClaim,
  type DirectoryClaim,
} from "$lib/server/taskspace-directory";
import type { TaskspaceDirectoryOutcome } from "$lib/types";
import { readJsonObject, requireBoundedName } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";
import { rethrowFilesError } from "./base-dir.js";
import { oneAtATime } from "./queue.js";

/** The taskspace visible on this board, or 404. */
async function visibleTaskspace(locals: App.Locals, namespaceId: string, taskspaceId: string) {
  const { db } = locals;
  if (!(await getNamespace({ db, namespaceId }))) throw error(404, "Namespace not found");
  const taskspace = await getTaskspaceInNamespace({ db, namespaceId, taskspaceId });
  if (!taskspace) throw error(404, "Taskspace not found");
  return taskspace;
}

type TaskspaceRow = { id: string; path: string | null; pathKind: PathKind };

/**
 * Where the browser may change this taskspace's directory on disk, with who owns what is
 * there, or null when the path is not where Kozane creates taskspaces.
 */
function managedDirectory(taskspace: TaskspaceRow) {
  const { path: storedPath, pathKind } = taskspace;
  if (!storedPath || taskspacePathIssue(storedPath, pathKind)) return null;
  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");
  const managed = isManagedTaskspaceDirectory({
    workspaceRoot: root,
    storedPath,
    pathKind,
    defaultDir: getTaskspaceDefaultDir(root),
  });
  if (!managed) return null;
  const target = { workspaceRoot: root, storedPath, taskspaceId: taskspace.id };
  let claim: DirectoryClaim;
  try {
    claim = taskspaceDirectoryClaim(target);
  } catch (e) {
    rethrowFilesError(e, "Failed to read taskspace directory");
  }
  return { ...target, claim };
}

/**
 * Rename a taskspace. A directory Kozane created moves to the new name too. Others, and one
 * whose directory is gone, change only the label. Return `{ id, name, path, pathKind }`.
 */
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);
  return oneAtATime(params.taskspaceId, () => rename(locals, params, name));
});

type TaskspaceParams = { namespaceId: string; taskspaceId: string };

async function rename(locals: App.Locals, params: TaskspaceParams, name: string) {
  const { db } = locals;
  const taskspace = await visibleTaskspace(locals, params.namespaceId, params.taskspaceId);
  const reply = (path: string | null) =>
    json({ id: taskspace.id, name, path, pathKind: taskspace.pathKind });

  if (name === taskspace.name) return reply(taskspace.path);

  const managed = managedDirectory(taskspace);
  // A missing directory has nothing to move, so only the label changes, as DELETE allows.
  if (managed?.claim !== "owned") {
    await updateTaskspace({ db, taskspaceId: taskspace.id, name });
    return reply(taskspace.path);
  }

  // The name becomes the directory, so it has to be one plain segment.
  const nameIssue = taskspaceNameIssue(name);
  if (nameIssue) throw error(400, nameIssue);

  let nextPath: string;
  try {
    nextPath = renameTaskspaceDirectory({ ...managed, newName: name });
  } catch (e) {
    rethrowFilesError(e, "Failed to rename taskspace directory");
  }

  try {
    await updateTaskspace({ db, taskspaceId: taskspace.id, name, path: nextPath });
  } catch (e) {
    // Put the directory back so the record and the disk keep agreeing.
    try {
      restoreTaskspaceDirectory(managed.workspaceRoot, nextPath, managed.storedPath);
    } catch (restoreError) {
      console.error("Failed to restore taskspace directory after rename:", restoreError);
    }
    throw e;
  }
  return reply(nextPath);
}

/**
 * Delete a taskspace. A directory Kozane created is deleted with everything in it, before
 * the record, so a failure leaves the taskspace in place to retry. Others keep their
 * directory. Return `{ ok: true, directory }`, where `directory` is `deleted`, `missing`, or
 * `kept`. Return 409 when a managed path holds a directory whose marker names another
 * taskspace, or none.
 */
export const DELETE: RequestHandler = apiHandler(({ locals, params }) =>
  oneAtATime(params.taskspaceId, () => remove(locals, params)),
);

async function remove(locals: App.Locals, params: TaskspaceParams) {
  const { db } = locals;
  const taskspace = await visibleTaskspace(locals, params.namespaceId, params.taskspaceId);
  const managed = managedDirectory(taskspace);

  let directory: TaskspaceDirectoryOutcome = "kept";
  if (managed?.claim === "missing") directory = "missing";
  else if (managed?.claim === "owned" || managed?.claim === "foreign") {
    // A foreign directory is refused inside, rather than quietly kept.
    try {
      directory = removeTaskspaceDirectory(managed);
    } catch (e) {
      rethrowFilesError(e, "Failed to delete taskspace directory");
    }
  }

  await deleteTaskspace({ db, taskspaceId: taskspace.id });
  return json({ ok: true, directory });
}
