import type { DB } from "../../../db/database.js";
import { TaskspaceServiceError } from "./errors.js";
import {
  createTaskspaceFile,
  readTaskspaceFile,
  writeTaskspaceFile,
} from "../../server/taskspace-files.js";
import { queuedFilesChange, rethrowFilesError, taskspaceBaseDir } from "./base-dir.js";
import { optionalString, requireString } from "../../../services/validation.js";

type Context = { db: DB };
type Params = { namespaceId: string; taskspaceId: string };

export async function readFile(locals: Context, params: Params, requestedPath: string | null) {
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
  try {
    return readTaskspaceFile({ baseDir, subPath: requestedPath ?? "" });
  } catch (e) {
    rethrowFilesError(e, "Failed to read taskspace file");
  }
}

export async function createFile(locals: Context, params: Params, body: Record<string, unknown>) {
  const subPath = requireString(body, "path");
  if (optionalString(body, "content") !== undefined)
    throw new TaskspaceServiceError(
      400,
      "content is not accepted here; create the file, then PUT its contents",
    );
  const created = await queuedFilesChange(
    locals,
    params,
    "Failed to create taskspace file",
    (baseDir) => createTaskspaceFile({ baseDir, subPath }),
  );
  return created;
}

export async function saveFile(locals: Context, params: Params, body: Record<string, unknown>) {
  const subPath = requireString(body, "path");
  const content = optionalString(body, "content");
  if (content === undefined) throw new TaskspaceServiceError(400, "content is required");
  if (!("signature" in body)) throw new TaskspaceServiceError(400, "signature is required");
  const signature = body.signature;
  if (signature !== null && typeof signature !== "string")
    throw new TaskspaceServiceError(400, "signature must be a string or null");
  const saved = await queuedFilesChange(
    locals,
    params,
    "Failed to save taskspace file",
    (baseDir) => writeTaskspaceFile({ baseDir, subPath, content, signature }),
  );
  return saved;
}
