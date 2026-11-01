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
} from "$lib/server/taskspace-directory";
import { readJsonObject, requireBoundedName } from "../../../lib/request.js";
import { apiHandler } from "../../../lib/api-handler.js";
import { rethrowFilesError } from "./base-dir.js";

/** The taskspace visible on this board, or 404. */
async function visibleTaskspace(locals: App.Locals, namespaceId: string, taskspaceId: string) {
  const { db } = locals;
  if (!(await getNamespace({ db, namespaceId }))) throw error(404, "Namespace not found");
  const taskspace = await getTaskspaceInNamespace({ db, namespaceId, taskspaceId });
  if (!taskspace) throw error(404, "Taskspace not found");
  return taskspace;
}

/** Whether the browser may change this taskspace's directory on disk. */
function managedDirectory(storedPath: string | null, pathKind: PathKind) {
  if (!storedPath || taskspacePathIssue(storedPath, pathKind)) return null;
  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");
  const managed = isManagedTaskspaceDirectory({
    storedPath,
    pathKind,
    defaultDir: getTaskspaceDefaultDir(root),
  });
  return managed ? { root, storedPath } : null;
}

/**
 * Rename a taskspace. A directory the browser manages moves to the new name too. Others keep
 * their directory and change only the label. Return `{ id, name, path, pathKind }`.
 */
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);
  const taskspace = await visibleTaskspace(locals, params.namespaceId, params.taskspaceId);
  const reply = (path: string | null) =>
    json({ id: taskspace.id, name, path, pathKind: taskspace.pathKind });

  if (name === taskspace.name) return reply(taskspace.path);

  const managed = managedDirectory(taskspace.path, taskspace.pathKind);
  if (!managed) {
    await updateTaskspace({ db, taskspaceId: taskspace.id, name });
    return reply(taskspace.path);
  }

  // The name becomes the directory, so it has to be one plain segment.
  const nameIssue = taskspaceNameIssue(name);
  if (nameIssue) throw error(400, nameIssue);

  let nextPath: string;
  try {
    nextPath = renameTaskspaceDirectory({
      workspaceRoot: managed.root,
      storedPath: managed.storedPath,
      newName: name,
    });
  } catch (e) {
    rethrowFilesError(e, "Failed to rename taskspace directory");
  }

  try {
    await updateTaskspace({ db, taskspaceId: taskspace.id, name, path: nextPath });
  } catch (e) {
    // Put the directory back so the record and the disk keep agreeing.
    try {
      restoreTaskspaceDirectory(managed.root, nextPath, managed.storedPath);
    } catch (restoreError) {
      console.error("Failed to restore taskspace directory after rename:", restoreError);
    }
    throw e;
  }
  return reply(nextPath);
});

/**
 * Delete a taskspace. A directory the browser manages is deleted with everything in it,
 * before the record, so a failure leaves the taskspace in place to retry. Others keep their
 * directory. Return `{ ok: true, directory }`, where `directory` is `deleted`, `missing`, or
 * `kept`.
 */
export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const taskspace = await visibleTaskspace(locals, params.namespaceId, params.taskspaceId);
  const managed = managedDirectory(taskspace.path, taskspace.pathKind);

  let directory: "deleted" | "missing" | "kept" = "kept";
  if (managed) {
    try {
      directory = removeTaskspaceDirectory({
        workspaceRoot: managed.root,
        storedPath: managed.storedPath,
        taskspaceId: taskspace.id,
      });
    } catch (e) {
      rethrowFilesError(e, "Failed to delete taskspace directory");
    }
  }

  await deleteTaskspace({ db, taskspaceId: taskspace.id });
  return json({ ok: true, directory });
});
