import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  createTaskspaceDirectory,
  deleteTaskspaceEntry,
  listTaskspaceDirectory,
  renameTaskspaceEntry,
} from "$lib/server/taskspace-files";
import { queuedFilesChange, rethrowFilesError, taskspaceBaseDir } from "../base-dir.js";
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
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const subPath = requireString(await readJsonObject(request), "path");
  const created = await queuedFilesChange(
    locals,
    params,
    "Failed to create taskspace directory",
    (baseDir) => createTaskspaceDirectory({ baseDir, subPath }),
  );
  return json(created, { status: 201 });
});

/**
 * Rename one file, directory, or symlink within its directory. Return the new path and the
 * entry's kind. Return 409 when the new name is taken.
 */
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const body = await readJsonObject(request);
  const subPath = requireString(body, "path");
  const name = requireString(body, "name");
  const renamed = await queuedFilesChange(
    locals,
    params,
    "Failed to rename taskspace entry",
    (baseDir) => renameTaskspaceEntry({ baseDir, subPath, name }),
  );
  return json(renamed);
});

/**
 * Delete one file or symlink, or a directory with everything under it, named by the `path`
 * query. The taskspace root itself cannot be deleted here.
 */
export const DELETE: RequestHandler = apiHandler(async ({ locals, params, url }) => {
  // A query rather than a body, which some proxies and clients drop from DELETE.
  const subPath = url.searchParams.get("path");
  if (!subPath) throw error(400, "path is required");
  const deleted = await queuedFilesChange(
    locals,
    params,
    "Failed to delete taskspace entry",
    (baseDir) => deleteTaskspaceEntry({ baseDir, subPath }),
  );
  return json(deleted);
});
