import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addTaskspace, deleteTaskspace } from "../../../../db/api/taskspace";
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

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  const defaultDir = getTaskspaceDefaultDir(root);
  const targetDir = resolve(join(root, defaultDir, name));

  if (!targetDir.startsWith(resolve(root) + "/"))
    throw error(400, "Taskspace path must be inside the workspace root");

  // The guard above ensures targetDir is always inside the workspace root,
  // so the path is always stored as project_relative. Absolute paths are
  // only produced by the CLI (kozane taskspace create --dir <outside-root>).
  const storedPath = relative(resolve(root), targetDir);

  const id = await addTaskspace({
    db,
    projectId: params.projectId,
    scopeId,
    name,
    path: storedPath,
    pathKind: "project_relative",
  });

  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(targetDir, TASKSPACE_MARKER_FILE),
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
  } catch (e) {
    console.error("Failed to initialize taskspace directory:", e);
    // Compensate: roll back the DB record and remove any partially-created directory.
    await deleteTaskspace({ db, taskspaceId: id });
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw error(500, "Failed to initialize taskspace directory");
  }

  return json({ id, path: storedPath, pathKind: "project_relative" });
};
