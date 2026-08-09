import { mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addTaskspace, deleteTaskspace } from "../../../../db/api/taskspace";
import { getProject } from "../../../../db/api/project";
import { getScope } from "../../../../db/api/scope";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { getWorkspaceRoot, getTaskspaceDefaultDir } from "../../../../db/internal/config";
import {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
} from "../../../../lib/taskspace-marker";
import { NAME_MAX } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");
  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);
  const scopeId = requireTrimmedString(body, "scopeId");

  if (!(await getProject({ db, projectId: params.projectId })))
    throw error(404, "Project not found");
  if (!(await getScope({ db, scopeId }))) throw error(400, "Scope not found");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  const defaultDir = getTaskspaceDefaultDir(root);
  const targetDir = resolve(join(root, defaultDir, name));

  // Containment is checked through `relative` rather than a string prefix so the
  // separator stays platform-correct and `name` cannot escape with "..".
  const storedPath = relative(resolve(root), targetDir);
  if (!storedPath || storedPath.startsWith("..") || isAbsolute(storedPath))
    throw error(400, "Taskspace path must be inside the workspace root");

  // The guard above ensures targetDir is always inside the workspace root,
  // so the path is always stored as project_relative. Absolute paths are
  // only produced by the CLI (kozane taskspace create --dir <outside-root>).

  const id = await addTaskspace({
    db,
    projectId: params.projectId,
    scopeId,
    name,
    path: storedPath,
    pathKind: "project_relative",
  });

  let targetCreated = false;
  const markerPath = join(targetDir, TASKSPACE_MARKER_FILE);
  try {
    // Shared parents are safe to create, but claim the taskspace directory atomically.
    await mkdir(dirname(targetDir), { recursive: true });
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
            projectId: params.projectId,
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
    const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
    if (code === "EEXIST") throw error(409, "Taskspace directory already exists");
    throw error(500, "Failed to initialize taskspace directory");
  }

  return json({ id, path: storedPath, pathKind: "project_relative" });
};
