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
 * Creates one directory, and answers with it in the shape `GET` uses — empty, necessarily.
 * The panel draws the new folder from that answer rather than asking again for a listing
 * it was just handed.
 *
 * On this route rather than beside the file creation on `file/` because what it makes is a
 * name and nothing else, which is exactly what this route deals in: `file/` is the only
 * endpoint that carries the contents of anything, and it stays that way.
 *
 * Non-recursive and never replacing: a parent that is not there is a `404`, and a name
 * already taken — by a file, a directory, or a symlink — is a `409`.
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
