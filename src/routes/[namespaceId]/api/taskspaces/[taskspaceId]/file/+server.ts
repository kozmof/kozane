import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  createTaskspaceFile,
  readTaskspaceFile,
  writeTaskspaceFile,
} from "$lib/server/taskspace-files";
import { queuedFilesChange, rethrowFilesError, taskspaceBaseDir } from "../base-dir.js";
import { optionalString, readJsonObject, requireString } from "../../../../lib/request.js";
import { apiHandler } from "../../../../lib/api-handler.js";

/**
 * Read a taskspace file for the editor. Accept only regular, non-hidden files with valid
 * UTF-8 within the size limit. Keep this separate from `files/`, which returns only names and
 * metadata.
 */
export const GET: RequestHandler = apiHandler(async ({ locals, params, url }) => {
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
  try {
    return json(readTaskspaceFile({ baseDir, subPath: url.searchParams.get("path") ?? "" }));
  } catch (e) {
    rethrowFilesError(e, "Failed to read taskspace file");
  }
});

/**
 * Create an empty file and return its path, content, and signature so editing can begin
 * without another request. Reject supplied content, which belongs in PUT, and return 409 if
 * the name is already taken.
 */
export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const body = await readJsonObject(request);
  const subPath = requireString(body, "path");
  if (optionalString(body, "content") !== undefined)
    throw error(400, "content is not accepted here; create the file, then PUT its contents");

  const created = await queuedFilesChange(
    locals,
    params,
    "Failed to create taskspace file",
    (baseDir) => createTaskspaceFile({ baseDir, subPath }),
  );
  return json(created, { status: 201 });
});

/**
 * Save text over an existing file only when the required read signature still matches. Return
 * 409 if the file changed since the editor read it.
 */
export const PUT: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const body = await readJsonObject(request);
  const subPath = requireString(body, "path");
  const content = optionalString(body, "content");
  if (content === undefined) throw error(400, "content is required");
  if (!("signature" in body)) throw error(400, "signature is required");
  const signature = body.signature;
  if (signature !== null && typeof signature !== "string")
    throw error(400, "signature must be a string or null");

  const saved = await queuedFilesChange(
    locals,
    params,
    "Failed to save taskspace file",
    (baseDir) => writeTaskspaceFile({ baseDir, subPath, content, signature }),
  );
  return json(saved);
});
