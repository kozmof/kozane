import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  createTaskspaceFile,
  readTaskspaceFile,
  writeTaskspaceFile,
} from "$lib/server/taskspace-files";
import { rethrowFilesError, taskspaceBaseDir } from "../base-dir.js";
import { optionalString, readJsonObject, requireString } from "../../../../lib/request.js";

/**
 * The text of one file of a taskspace, for the editor the scope panel opens.
 *
 * Deliberately a separate endpoint from the sibling `files/` listing rather than a mode of
 * it, so that "names and metadata only" stays true of that route without qualification.
 * What may be read here is narrower than what is listed there: regular files only, under a
 * size cap, valid UTF-8, and never a dot-entry.
 */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
  try {
    return json(readTaskspaceFile({ baseDir, subPath: url.searchParams.get("path") ?? "" }));
  } catch (e) {
    rethrowFilesError(e, "Failed to read taskspace file");
  }
};

/**
 * Creates one empty file and answers with it as the editor would have opened it —
 * `path`, an empty `content`, and the `signature` those empty bytes have — so the panel can
 * go straight into editing without a second request for a file it just made.
 *
 * Empty is all it makes. Content arrives through `PUT` like every other save, so the rules
 * about what may be written are applied to the first one as to the rest; a body carrying
 * `content` is refused rather than quietly ignored, since silently dropping what someone
 * sent is worse than telling them where it goes.
 *
 * `409` when something is already at that name: creating never replaces what it finds, and
 * a client that meant to overwrite has `PUT` and a signature for saying so.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
  const body = await readJsonObject(request);
  const subPath = requireString(body, "path");
  if (optionalString(body, "content") !== undefined)
    throw error(400, "content is not accepted here; create the file, then PUT its contents");

  try {
    return json(createTaskspaceFile({ baseDir, subPath }), { status: 201 });
  } catch (e) {
    rethrowFilesError(e, "Failed to create taskspace file");
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
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
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
    rethrowFilesError(e, "Failed to save taskspace file");
  }
};
