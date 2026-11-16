import type { DB } from "../../../db/database.js";
import { TaskspaceServiceError } from "./errors.js";
import {
  deleteTaskspace,
  getAllTaskspaces,
  getTaskspaceInNamespace,
  updateTaskspace,
} from "../../../db/api/taskspace.js";
import { getAllNamespaces, getNamespace } from "../../../db/api/namespace.js";
import { getTaskspacePlacementConfig, getWorkspaceRoot } from "../../../db/internal/config.js";
import { taskspaceNameIssue, type PathKind } from "../../constants.js";
import { taskspacePathIssue } from "../taskspace-path.js";
import {
  holdsOtherTaskspaces,
  isManagedTaskspaceDirectory,
  removeTaskspaceDirectory,
  renameTaskspaceDirectory,
  directoryRemovalError,
  taskspaceDirectoryClaim,
  type DirectoryClaim,
} from "../taskspace-directory.js";
import type { TaskspaceDirectoryOutcome } from "../../types.js";
import { requireBoundedName } from "../../../services/validation.js";
import { rethrowFilesError } from "./base-dir.js";
import { oneAtATime } from "./queue.js";
import { journalTaskspaceDirectoryChange } from "./directory-operation.js";
import { LocalOperationError } from "./journal-operation.js";
/** The taskspace visible on this board, or 404. */
async function visibleTaskspace(locals: { db: DB }, namespaceId: string, taskspaceId: string) {
  const { db } = locals;
  if (!(await getNamespace({ db, namespaceId })))
    throw new TaskspaceServiceError(404, "Namespace not found");
  const taskspace = await getTaskspaceInNamespace({ db, namespaceId, taskspaceId });
  if (!taskspace) throw new TaskspaceServiceError(404, "Taskspace not found");
  return taskspace;
}
type TaskspaceRow = {
  id: string;
  path: string | null;
  pathKind: PathKind;
};
/**
 * Where the browser may change this taskspace's directory on disk, with who owns what is
 * there, or null when the path is not where Kozane creates taskspaces.
 */
async function managedDirectory(db: DB, taskspace: TaskspaceRow) {
  const { path: storedPath, pathKind } = taskspace;
  if (!storedPath || taskspacePathIssue(storedPath, pathKind)) return null;
  const root = getWorkspaceRoot();
  if (!root)
    throw new TaskspaceServiceError(503, "No Kozane workspace found. Run 'kozane init' first.");
  // Kozane only manages directories it stored relative to the workspace.
  if (pathKind !== "workspace_relative") return null;
  // Read the same settings create uses, so a directory Kozane just made is always managed.
  // An invalid config manages nothing: the label still changes and the directory is kept.
  const placement = getTaskspacePlacementConfig(root);
  if (!placement.ok) return null;
  // Loaded only here, after the cheap checks above have passed.
  const namespaces = await getAllNamespaces({ db });
  const managed = isManagedTaskspaceDirectory({
    workspaceRoot: root,
    storedPath,
    pathKind,
    placement: placement.value,
    namespaces,
  });
  if (!managed) return null;
  // Another taskspace inside this directory would move or be deleted with it, so leave the
  // directory alone: rename changes only the label, and delete keeps it.
  if (holdsOtherTaskspaces(root, taskspace, await getAllTaskspaces({ db }))) return null;
  const target = { workspaceRoot: root, storedPath, taskspaceId: taskspace.id };
  let claim: DirectoryClaim;
  try {
    claim = taskspaceDirectoryClaim(target);
  } catch (e) {
    rethrowFilesError(e, "Failed to read taskspace directory");
  }
  return { ...target, claim };
}
type TaskspaceParams = {
  namespaceId: string;
  taskspaceId: string;
};
async function recheckManagedDirectory(
  db: DB,
  taskspace: TaskspaceRow,
  expected: { workspaceRoot: string; storedPath: string },
) {
  const current = await managedDirectory(db, taskspace);
  if (
    !current ||
    current.claim !== "owned" ||
    current.workspaceRoot !== expected.workspaceRoot ||
    current.storedPath !== expected.storedPath
  )
    throw new TaskspaceServiceError(409, "Taskspace directory changed before the operation");
}
function rethrowDirectoryChange(error: unknown, whatFailed: string): never {
  if (error instanceof LocalOperationError) {
    if (error.phase === "confirm")
      throw new TaskspaceServiceError(
        500,
        "Directory change needs recovery. Run 'kozane doctor' before repeating it.",
      );
    if (error.cause instanceof TaskspaceServiceError) throw error.cause;
    rethrowFilesError(error.cause, whatFailed);
  }
  if (error instanceof TaskspaceServiceError) throw error;
  rethrowFilesError(error, whatFailed);
}
async function rename(locals: { db: DB }, params: TaskspaceParams, name: string) {
  const { db } = locals;
  const taskspace = await visibleTaskspace(locals, params.namespaceId, params.taskspaceId);
  const reply = (path: string | null) => ({
    id: taskspace.id,
    name,
    path,
    pathKind: taskspace.pathKind,
  });
  if (name === taskspace.name) return reply(taskspace.path);
  const managed = await managedDirectory(db, taskspace);
  // A missing directory has nothing to move, so only the label changes, as DELETE allows.
  if (managed?.claim !== "owned") {
    await updateTaskspace({ db, taskspaceId: taskspace.id, name });
    return reply(taskspace.path);
  }
  // The name becomes the directory, so it has to be one plain segment.
  const nameIssue = taskspaceNameIssue(name);
  if (nameIssue) throw new TaskspaceServiceError(400, nameIssue);
  try {
    return await journalTaskspaceDirectoryChange(
      {
        db,
        namespaceId: params.namespaceId,
        root: managed.workspaceRoot,
        original: taskspace,
        request: { operation: "move", name },
        recheck: () => recheckManagedDirectory(db, taskspace, managed),
      },
      () => renameTaskspaceDirectory({ ...managed, newName: name }),
      async (tx, nextPath) => {
        await updateTaskspace({ db: tx, taskspaceId: taskspace.id, name, path: nextPath });
        return reply(nextPath);
      },
    );
  } catch (error) {
    rethrowDirectoryChange(error, "Failed to rename taskspace directory");
  }
}
async function remove(locals: { db: DB }, params: TaskspaceParams) {
  const { db } = locals;
  const taskspace = await visibleTaskspace(locals, params.namespaceId, params.taskspaceId);
  const managed = await managedDirectory(db, taskspace);
  let directory: TaskspaceDirectoryOutcome = "kept";
  if (managed?.claim === "missing") directory = "missing";
  else if (managed?.claim === "foreign") {
    rethrowFilesError(directoryRemovalError(taskspace.id), "Failed to delete taskspace directory");
  } else if (managed?.claim === "owned") {
    try {
      return await journalTaskspaceDirectoryChange(
        {
          db,
          namespaceId: params.namespaceId,
          root: managed.workspaceRoot,
          original: taskspace,
          request: { operation: "remove" },
          recheck: () => recheckManagedDirectory(db, taskspace, managed),
        },
        () => removeTaskspaceDirectory(managed),
        async (tx, outcome) => {
          await deleteTaskspace({ db: tx, taskspaceId: taskspace.id });
          return { ok: true, directory: outcome };
        },
      );
    } catch (error) {
      rethrowDirectoryChange(error, "Failed to delete taskspace directory");
    }
  }
  await deleteTaskspace({ db, taskspaceId: taskspace.id });
  return { ok: true, directory };
}
export function renameTaskspace(
  locals: {
    db: DB;
  },
  params: TaskspaceParams,
  body: Record<string, unknown>,
) {
  const name = requireBoundedName(body);
  return oneAtATime(params.taskspaceId, () => rename(locals, params, name));
}
export function removeTaskspace(
  locals: {
    db: DB;
  },
  params: TaskspaceParams,
) {
  return oneAtATime(params.taskspaceId, () => remove(locals, params));
}
