import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createTaskspaceDirectory, listTaskspaceDirectory } from "$lib/server/taskspace-files";
import { rethrowFilesError, taskspaceBaseDir } from "../base-dir.js";
import { readJsonObject, requireString } from "../../../../lib/request.js";

/**
 * One directory of a taskspace, for the tree the scope panel draws. The panel asks per
 * directory as folders are opened rather than for a whole tree at once, so a taskspace
 * that happens to contain a checkout costs one small answer per folder actually looked at.
 *
 * Names and metadata only. There is no endpoint that returns the contents of a file.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  // The base comes from the record and the workspace root alone. The request chooses only
  // where to look within it, and `listTaskspaceDirectory` is what holds it to that.
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);

  try {
    return json(listTaskspaceDirectory({ baseDir, subPath: url.searchParams.get("path") ?? "" }));
  } catch (e) {
    rethrowFilesError(e, "Failed to list taskspace directory");
  }
};

/**
 * Create one directory and return its empty listing. Require an existing parent and return
 * 409 when any entry already occupies the requested name.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
  const body = await readJsonObject(request);
  const subPath = requireString(body, "path");

  try {
    return json(createTaskspaceDirectory({ baseDir, subPath }), { status: 201 });
  } catch (e) {
    rethrowFilesError(e, "Failed to create taskspace directory");
  }
};
