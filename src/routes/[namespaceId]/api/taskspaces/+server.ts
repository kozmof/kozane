import { dirname, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addTaskspace, deleteTaskspace } from "$db/api/taskspace";
import { getAllNamespaces, getNamespace } from "$db/api/namespace";
import { getScope } from "$db/api/scope";
import { readJsonObject, requireBoundedName, requireTrimmedString } from "../../lib/request.js";
import { getWorkspaceRoot, getTaskspacePlacementConfig } from "$db/internal/config";
import { AmbiguousNamespacePathError, taskspaceParentDir } from "$lib/taskspace-location";
import { taskspaceNameIssue } from "$lib/constants";
import { errorCode } from "$lib/server/fs-paths";
import { claimTaskspaceDirectory, enclosingTaskspaceDir } from "$lib/server/taskspace-directory";
import { TaskspaceFilesError } from "$lib/server/taskspace-files";
import { storedLocation } from "$lib/server/taskspace-path";
import { apiHandler } from "../../lib/api-handler.js";

export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireBoundedName(body);
  const nameIssue = taskspaceNameIssue(name);
  if (nameIssue) throw error(400, nameIssue);
  const scopeId = requireTrimmedString(body, "scopeId");

  const namespace = await getNamespace({ db, namespaceId: params.namespaceId });
  if (!namespace) throw error(404, "Namespace not found");
  if (!(await getScope({ db, scopeId }))) throw error(400, "Scope not found");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  const placement = getTaskspacePlacementConfig(root);
  if (!placement.ok) throw error(400, `Fix .kozane/config.json: ${placement.issue}`);

  let parentDir: string;
  try {
    parentDir = taskspaceParentDir({
      ...placement.value,
      namespaceId: namespace.id,
      namespaces: await getAllNamespaces({ db }),
    });
  } catch (e) {
    if (e instanceof AmbiguousNamespacePathError) throw error(400, e.message);
    throw e;
  }
  // `resolve`, not `join`, so a configured absolute path is used as it is.
  const targetDir = resolve(root, parentDir, name);

  // The configured directories come from the config file and may point outside the root.
  // Absolute paths are only stored by the CLI, such as `kozane taskspace create --dir`.
  const { pathKind, storedPath } = storedLocation(root, targetDir);
  if (pathKind !== "workspace_relative")
    throw error(400, "Taskspace path must be inside the workspace root");

  // Never inside another taskspace's directory, which deleting that taskspace would remove.
  const enclosing = enclosingTaskspaceDir(root, dirname(targetDir));
  if (enclosing)
    throw error(
      409,
      `Taskspace directory would be inside the taskspace at ${relative(resolve(root), enclosing)}. ` +
        "Move that taskspace or change taskspace.defaultDir or taskspace.namespacePaths.",
    );

  const id = await addTaskspace({
    db,
    namespaceId: params.namespaceId,
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
      namespaceId: params.namespaceId,
      adoptExisting: false,
      parentsInside: true,
      ownIfCreated: true,
    });
  } catch (e) {
    console.error("Failed to initialize taskspace directory:", e);
    await deleteTaskspace({ db, taskspaceId: id });
    if (e instanceof TaskspaceFilesError && e.reason === "invalid-path")
      throw error(400, "Taskspace path must be inside the workspace root");
    if ((e instanceof TaskspaceFilesError && e.reason === "exists") || errorCode(e) === "EEXIST")
      throw error(409, "Taskspace directory already exists");
    throw error(500, "Failed to initialize taskspace directory");
  }

  return json({ id, path: storedPath, pathKind });
});
