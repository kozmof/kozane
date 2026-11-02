import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  createTaskspaceDirectory,
  deleteTaskspaceEntry,
  listTaskspaceDirectory,
  renameTaskspaceEntry,
} from "$lib/server/taskspace-files";
import { rethrowFilesError, taskspaceBaseDir } from "../base-dir.js";
import { oneAtATime } from "../queue.js";
import { readJsonObject, requireString } from "../../../../lib/request.js";
import { apiHandler } from "../../../../lib/api-handler.js";

/**
 * List names and metadata for one taskspace directory. Load directories as folders open to
 * avoid reading the full tree. The sibling `file/` endpoint returns file content.
 */
export const GET: RequestHandler = apiHandler(async ({ locals, params, url }) => {
  // Resolve the trusted root from workspace data. `listTaskspaceDirectory` keeps the
  // requested path inside that root.
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);

  try {
    return json(listTaskspaceDirectory({ baseDir, subPath: url.searchParams.get("path") ?? "" }));
  } catch (e) {
    rethrowFilesError(e, "Failed to list taskspace directory");
  }
});

/**
 * Create one directory and return its empty listing. Require an existing parent and return
 * 409 when any entry already occupies the requested name.
 */
export const POST: RequestHandler = apiHandler(({ locals, params, request }) =>
  oneAtATime(params.taskspaceId, async () => {
    const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
    const body = await readJsonObject(request);
    const subPath = requireString(body, "path");

    try {
      return json(createTaskspaceDirectory({ baseDir, subPath }), { status: 201 });
    } catch (e) {
      rethrowFilesError(e, "Failed to create taskspace directory");
    }
  }),
);

/**
 * Rename one file, directory, or symlink within its directory. Return the new path and the
 * entry's kind. Return 409 when the new name is taken.
 */
export const PATCH: RequestHandler = apiHandler(({ locals, params, request }) =>
  oneAtATime(params.taskspaceId, async () => {
    const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
    const body = await readJsonObject(request);
    const subPath = requireString(body, "path");
    const name = requireString(body, "name");

    try {
      return json(renameTaskspaceEntry({ baseDir, subPath, name }));
    } catch (e) {
      rethrowFilesError(e, "Failed to rename taskspace entry");
    }
  }),
);

/**
 * Delete one file or symlink, or a directory with everything under it. The taskspace root
 * itself cannot be deleted here.
 */
export const DELETE: RequestHandler = apiHandler(({ locals, params, request }) =>
  oneAtATime(params.taskspaceId, async () => {
    const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
    const body = await readJsonObject(request);
    const subPath = requireString(body, "path");

    try {
      return json(deleteTaskspaceEntry({ baseDir, subPath }));
    } catch (e) {
      rethrowFilesError(e, "Failed to delete taskspace entry");
    }
  }),
);
