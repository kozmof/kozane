import type { DB } from "../../../db/database.js";
import { TaskspaceServiceError } from "./errors.js";
import {
  createTaskspaceDirectory,
  deleteTaskspaceEntry,
  listTaskspaceDirectory,
  renameTaskspaceEntry,
} from "../taskspace-files.js";
import { queuedFilesChange, rethrowFilesError, taskspaceBaseDir } from "./base-dir.js";
import { requireString } from "../../../services/validation.js";

type Context = { db: DB };
type Params = { namespaceId: string; taskspaceId: string };

export async function listDirectory(locals: Context, params: Params, requestedPath: string | null) {
  // Resolve the trusted root from workspace data. `listTaskspaceDirectory` keeps the
  // requested path inside that root.
  const baseDir = await taskspaceBaseDir(locals, params.namespaceId, params.taskspaceId);
  try {
    return listTaskspaceDirectory({ baseDir, subPath: requestedPath ?? "" });
  } catch (e) {
    rethrowFilesError(e, "Failed to list taskspace directory");
  }
}

export async function createDirectory(
  locals: Context,
  params: Params,
  body: Record<string, unknown>,
) {
  const subPath = requireString(await body, "path");
  const created = await queuedFilesChange(
    locals,
    params,
    "Failed to create taskspace directory",
    (baseDir) => createTaskspaceDirectory({ baseDir, subPath }),
  );
  return created;
}

export async function renameEntry(locals: Context, params: Params, body: Record<string, unknown>) {
  const subPath = requireString(body, "path");
  const name = requireString(body, "name");
  const renamed = await queuedFilesChange(
    locals,
    params,
    "Failed to rename taskspace entry",
    (baseDir) => renameTaskspaceEntry({ baseDir, subPath, name }),
  );
  return renamed;
}

export async function removeEntry(locals: Context, params: Params, requestedPath: string | null) {
  // A query rather than a body, which some proxies and clients drop from DELETE.
  const subPath = requestedPath;
  if (!subPath) throw new TaskspaceServiceError(400, "path is required");
  const deleted = await queuedFilesChange(
    locals,
    params,
    "Failed to delete taskspace entry",
    (baseDir) => deleteTaskspaceEntry({ baseDir, subPath }),
  );
  return deleted;
}
