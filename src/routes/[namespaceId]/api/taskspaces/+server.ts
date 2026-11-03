import { mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addTaskspace, deleteTaskspace } from "$db/api/taskspace";
import { getAllNamespaces, getNamespace } from "$db/api/namespace";
import { getScope } from "$db/api/scope";
import { readJsonObject, requireBoundedName, requireTrimmedString } from "../../lib/request.js";
import { getWorkspaceRoot, getTaskspacePlacementConfig } from "$db/internal/config";
import { AmbiguousNamespacePathError, taskspaceParentDir } from "$lib/server/taskspace-location";
import { taskspaceNameIssue } from "$lib/constants";
import {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
} from "../../../../lib/taskspace-marker.js";
import { errorCode, isStrictlyInside } from "$lib/server/fs-paths";
import { makeParentsInside, removeEmptyDirs } from "$lib/server/taskspace-directory";
import { apiHandler } from "../../lib/api-handler.js";

/** The taskspace's parent resolves, through a symlink, to somewhere outside the workspace. */
class OutsideWorkspaceError extends Error {}

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

  // Containment is checked through `relative` rather than a string prefix so the
  // separator stays platform-correct. The name and namespace folder are one segment each,
  // but the configured directories come from the config file and may point outside the root.
  const storedPath = relative(resolve(root), targetDir);
  if (!isStrictlyInside(resolve(root), targetDir))
    throw error(400, "Taskspace path must be inside the workspace root");

  // The guard above ensures targetDir is always inside the workspace root,
  // so the path is always stored as workspace_relative. Absolute paths are
  // only produced by the CLI (kozane taskspace create --dir <outside-root>).

  const id = await addTaskspace({
    db,
    namespaceId: params.namespaceId,
    scopeId,
    name,
    path: storedPath,
    pathKind: "workspace_relative",
  });

  let targetCreated = false;
  let parentsCreated: string[] = [];
  const markerPath = join(targetDir, TASKSPACE_MARKER_FILE);
  try {
    // Shared parents are safe to create, but claim the taskspace directory atomically. The
    // textual check above cannot see symlinks, so this also checks where the parent really is,
    // and creates nothing when a parent such as `tasks -> /elsewhere` leads outside.
    const created = makeParentsInside(root, dirname(targetDir));
    if (!created) throw new OutsideWorkspaceError();
    parentsCreated = created;
    await mkdir(targetDir);
    targetCreated = true;
    const marker = await open(markerPath, "wx", 0o600);
    try {
      await marker.writeFile(
        JSON.stringify(
          {
            kind: TASKSPACE_MARKER_KIND,
            version: TASKSPACE_MARKER_VERSION,
            taskspaceId: id,
            namespaceId: params.namespaceId,
            // This route always makes the directory itself, so the browser may manage it.
            ownsDirectory: true,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await marker.close();
    }
  } catch (e) {
    console.error("Failed to initialize taskspace directory:", e);
    await deleteTaskspace({ db, taskspaceId: id });
    // Remove only artifacts created by this request. Never recurse into the target.
    if (targetCreated) {
      await unlink(markerPath).catch(() => undefined);
      await rmdir(targetDir).catch(() => undefined);
    }
    // Then the folders above it that this request made, such as a new namespace folder.
    removeEmptyDirs(parentsCreated);
    if (e instanceof OutsideWorkspaceError)
      throw error(400, "Taskspace path must be inside the workspace root");
    const code = errorCode(e);
    if (code === "EEXIST") throw error(409, "Taskspace directory already exists");
    throw error(500, "Failed to initialize taskspace directory");
  }

  return json({ id, path: storedPath, pathKind: "workspace_relative" });
});
