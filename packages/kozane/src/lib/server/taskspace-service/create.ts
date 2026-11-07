import type { DB } from "../../../db/database.js";
import { TaskspaceServiceError } from "./errors.js";
import { dirname, relative, resolve } from "node:path";
import { addTaskspace, deleteTaskspace } from "../../../db/api/taskspace.js";
import { getAllNamespaces, getNamespace } from "../../../db/api/namespace.js";
import { getScope } from "../../../db/api/scope.js";
import { requireBoundedName, requireTrimmedString } from "../../../services/validation.js";
import { getWorkspaceRoot, getTaskspacePlacementConfig } from "../../../db/internal/config.js";
import { AmbiguousNamespacePathError, taskspaceParentDir } from "../../taskspace-location.js";
import { taskspaceNameIssue } from "../../constants.js";
import { errorCode } from "../fs-paths.js";
import { claimTaskspaceDirectory, enclosingTaskspaceDir } from "../taskspace-directory.js";
import { TaskspaceFilesError } from "../taskspace-files.js";
import { storedLocation } from "../taskspace-path.js";
export async function createTaskspace(db: DB, namespaceId: string, body: Record<string, unknown>) {
  const name = requireBoundedName(body);
  const nameIssue = taskspaceNameIssue(name);
  if (nameIssue) throw new TaskspaceServiceError(400, nameIssue);
  const scopeId = requireTrimmedString(body, "scopeId");
  const namespace = await getNamespace({ db, namespaceId: namespaceId });
  if (!namespace) throw new TaskspaceServiceError(404, "Namespace not found");
  if (!(await getScope({ db, scopeId }))) throw new TaskspaceServiceError(400, "Scope not found");
  const root = getWorkspaceRoot();
  if (!root)
    throw new TaskspaceServiceError(503, "No Kozane workspace found. Run 'kozane init' first.");
  const placement = getTaskspacePlacementConfig(root);
  if (!placement.ok)
    throw new TaskspaceServiceError(400, `Fix .kozane/config.json: ${placement.issue}`);
  let parentDir: string;
  try {
    parentDir = taskspaceParentDir({
      ...placement.value,
      namespaceId: namespace.id,
      namespaces: await getAllNamespaces({ db }),
    });
  } catch (e) {
    if (e instanceof AmbiguousNamespacePathError) throw new TaskspaceServiceError(400, e.message);
    throw e;
  }
  // `resolve`, not `join`, so a configured absolute path is used as it is.
  const targetDir = resolve(root, parentDir, name);
  // The configured directories come from the config file and may point outside the root.
  // Absolute paths are only stored by the CLI, such as `kozane taskspace create --dir`.
  const { pathKind, storedPath } = storedLocation(root, targetDir);
  if (pathKind !== "workspace_relative")
    throw new TaskspaceServiceError(400, "Taskspace path must be inside the workspace root");
  // Never inside another taskspace's directory, which deleting that taskspace would remove.
  const enclosing = enclosingTaskspaceDir(root, dirname(targetDir));
  if (enclosing)
    throw new TaskspaceServiceError(
      409,
      `Taskspace directory would be inside the taskspace at ${relative(resolve(root), enclosing)}. ` +
        "Move that taskspace or change taskspace.defaultDir or taskspace.namespacePaths.",
    );
  const id = await addTaskspace({
    db,
    namespaceId: namespaceId,
    scopeId,
    name,
    path: storedPath,
    pathKind,
  });
  try {
    // The path is stored relative, so its parents must really be inside the workspace. The
    // browser always makes the directory itself, so it may manage it.
    claimTaskspaceDirectory({
      workspaceRoot: root,
      targetDir,
      taskspaceId: id,
      namespaceId: namespaceId,
      adoptExisting: false,
      parentsInside: true,
      ownIfCreated: true,
    });
  } catch (e) {
    console.error("Failed to initialize taskspace directory:", e);
    await deleteTaskspace({ db, taskspaceId: id });
    if (e instanceof TaskspaceFilesError && e.reason === "invalid-path")
      throw new TaskspaceServiceError(400, "Taskspace path must be inside the workspace root");
    if ((e instanceof TaskspaceFilesError && e.reason === "exists") || errorCode(e) === "EEXIST")
      throw new TaskspaceServiceError(409, "Taskspace directory already exists");
    throw new TaskspaceServiceError(500, "Failed to initialize taskspace directory");
  }
  return { id, path: storedPath, pathKind };
}
