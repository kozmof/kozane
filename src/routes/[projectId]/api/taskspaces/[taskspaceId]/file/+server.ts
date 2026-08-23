import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getProject } from "../../../../../../db/api/project";
import { getTaskspace } from "../../../../../../db/api/taskspace";
import { getWorkspaceRoot } from "../../../../../../db/internal/config";
import { resolveTaskspacePath } from "$lib/taskspace-path";
import {
  readTaskspaceFile,
  TASKSPACE_FILES_STATUS,
  TaskspaceFilesError,
  writeTaskspaceFile,
} from "$lib/server/taskspace-files";
import { optionalString, readJsonObject, requireString } from "../../../../lib/request";

/**
 * The taskspace directory one request is confined to, resolved from the record and the
 * workspace root alone. The request chooses only where to look within it, and
 * `readTaskspaceFile`/`writeTaskspaceFile` are what hold it to that.
 *
 * The same lookup the sibling `files/` route makes, for the same reason: the board only
 * ever asks about taskspaces it was given, and the boundary that matters is the one
 * enforced below rather than how the row was found.
 */
async function taskspaceBaseDir(locals: App.Locals, projectId: string, taskspaceId: string) {
  const { db } = locals;

  if (!(await getProject({ db, projectId }))) throw error(404, "Project not found");

  const taskspace = await getTaskspace({ db, taskspaceId });
  if (!taskspace) throw error(404, "Taskspace not found");
  if (!taskspace.path) throw error(404, "Taskspace has no directory");

  const root = getWorkspaceRoot();
  if (!root) throw error(503, "No Kozane workspace found. Run 'kozane init' first.");

  return resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
}

function rethrow(e: unknown, whatFailed: string): never {
  if (e instanceof TaskspaceFilesError) throw error(TASKSPACE_FILES_STATUS[e.reason], e.message);
  console.error(`${whatFailed}:`, e);
  throw error(500, whatFailed);
}

/**
 * The text of one file of a taskspace, for the editor the scope panel opens.
 *
 * Deliberately a separate endpoint from the sibling `files/` listing rather than a mode of
 * it, so that "names and metadata only" stays true of that route without qualification.
 * What may be read here is narrower than what is listed there: regular files only, under a
 * size cap, valid UTF-8, and never a dot-entry.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const baseDir = await taskspaceBaseDir(locals, params.projectId, params.taskspaceId);
  try {
    return json(readTaskspaceFile({ baseDir, subPath: url.searchParams.get("path") ?? "" }));
  } catch (e) {
    rethrow(e, "Failed to read taskspace file");
  }
};

/**
 * Saves the editor's text back over an existing file.
 *
 * `signature` is what the editor read the file at. It is compared against the file as it
 * is now, so a save that would discard a change made on disk since then is refused with a
 * 409 rather than silently winning. Sending it is not optional — a body without one is a
 * request to overwrite whatever happens to be there.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const baseDir = await taskspaceBaseDir(locals, params.projectId, params.taskspaceId);
  const body = await readJsonObject(request);
  const subPath = requireString(body, "path");
  const content = optionalString(body, "content");
  if (content === undefined) throw error(400, "content is required");
  if (!("signature" in body)) throw error(400, "signature is required");
  const signature = body.signature;
  if (signature !== null && typeof signature !== "string")
    throw error(400, "signature must be a string or null");

  try {
    return json(writeTaskspaceFile({ baseDir, subPath, content, signature }));
  } catch (e) {
    rethrow(e, "Failed to save taskspace file");
  }
};
