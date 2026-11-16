/** Immutable local intent and read-only disk evidence for taskspace file mutations. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { and, count, eq } from "drizzle-orm";
import type { DB } from "../../db/database.js";
import { localFileOperationTable } from "../../db/schema.js";
import { TASKSPACE_FILE_BYTES_MAX } from "../constants.js";
import { entryNameIssue } from "../entry-name.js";
import { contentHash } from "./local-file-operations.js";
import { resolveTaskspaceEntry, TaskspaceFilesError } from "./taskspace-files.js";
import { resolveTaskspacePath, storedLocation } from "./taskspace-path.js";
import { errorCode } from "./fs-paths.js";

export type TaskspaceFileChange = { subPath: string } & (
  | { operation: "create-file" | "create-directory" | "remove-entry" }
  | { operation: "save-file"; content: string; signature: string | null }
  | { operation: "rename-entry"; name: string }
);
type Operation = typeof localFileOperationTable.$inferSelect;

export function prepareTaskspaceFileChange(
  root: string,
  baseDir: string,
  change: TaskspaceFileChange,
) {
  const location = resolveTaskspaceEntry(baseDir, change.subPath);
  const stored = storedLocation(root, location.real);
  const intent = { operation: change.operation, requestedPath: change.subPath } as {
    operation: TaskspaceFileChange["operation"];
    requestedPath: string;
    contentHash?: string;
    signature?: string | null;
    name?: string;
    targetPath?: string;
  };
  if (change.operation === "create-file") intent.contentHash = contentHash("");
  if (change.operation === "save-file") {
    intent.contentHash = contentHash(change.content);
    intent.signature = change.signature;
  }
  if (change.operation === "rename-entry") {
    const issue = entryNameIssue(change.name);
    if (issue) throw new TaskspaceFilesError("invalid-path", issue);
    intent.name = change.name;
    intent.targetPath = join(dirname(stored.storedPath), change.name);
  }
  return { ...location, ...stored, intent: JSON.stringify(intent) };
}

export type FileObservation =
  | "invalid-intent"
  | "unsafe-path"
  | "unreadable"
  | "entry-absent"
  | "entry-present"
  | "matching-content"
  | "different-content"
  | "directory-present"
  | "source-only"
  | "target-only"
  | "both-present"
  | "both-absent";

/** Validate relative rename destinations before any path from an imported intent is read. */
function parseIntent(operation: Operation) {
  if (operation.kind !== "taskspace.file" || operation.version !== 1) return null;
  try {
    const intent = JSON.parse(operation.intent);
    if (
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      typeof intent.requestedPath !== "string"
    )
      return null;
    const fields = ["operation", "requestedPath"];
    switch (intent.operation) {
      case "create-file":
        fields.push("contentHash");
        if (intent.contentHash !== contentHash("")) return null;
        break;
      case "save-file":
        fields.push("contentHash", "signature");
        if (
          typeof intent.contentHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(intent.contentHash) ||
          (intent.signature !== null && typeof intent.signature !== "string")
        )
          return null;
        break;
      case "rename-entry":
        fields.push("name", "targetPath");
        if (
          typeof intent.name !== "string" ||
          entryNameIssue(intent.name) ||
          intent.targetPath !== join(dirname(operation.path), intent.name)
        )
          return null;
        break;
      case "create-directory":
      case "remove-entry":
        break;
      default:
        return null;
    }
    if (
      Object.keys(intent).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(intent, field))
    )
      return null;
    return intent as {
      operation: TaskspaceFileChange["operation"];
      contentHash?: string;
      targetPath?: string;
    };
  } catch {
    return null;
  }
}

/** Observe an entry without following any symlink in its parent directories. */
function entry(path: string) {
  const parents: string[] = [];
  for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
    parents.unshift(parent);
    if (dirname(parent) === parent) break;
  }
  for (const parent of parents) {
    try {
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe-path" as const;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export function inspectTaskspaceFileOperation(operation: Operation, root: string): FileObservation {
  const intent = parseIntent(operation);
  if (!intent) return "invalid-intent";
  const path = resolveTaskspacePath(operation.path, operation.pathKind, root);
  if (!path) return "unsafe-path";
  try {
    const source = entry(path);
    if (source === "unsafe-path") return source;
    if (intent.operation === "rename-entry") {
      const target = resolveTaskspacePath(intent.targetPath!, operation.pathKind, root);
      if (!target) return "unsafe-path";
      const destination = entry(target);
      if (destination === "unsafe-path") return destination;
      return source
        ? destination
          ? "both-present"
          : "source-only"
        : destination
          ? "target-only"
          : "both-absent";
    }
    if (!source) return "entry-absent";
    if (intent.operation === "remove-entry") return "entry-present";
    if (intent.operation === "create-directory")
      return source.isDirectory() ? "directory-present" : "entry-present";
    if (source.isSymbolicLink()) return "unsafe-path";
    if (!source.isFile() || source.size > TASKSPACE_FILE_BYTES_MAX) return "different-content";
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > TASKSPACE_FILE_BYTES_MAX) return "different-content";
      const bytes = Buffer.alloc(65536);
      const hash = createHash("sha256");
      let size = 0;
      while (size <= TASKSPACE_FILE_BYTES_MAX) {
        const read = readSync(
          fd,
          bytes,
          0,
          Math.min(bytes.length, TASKSPACE_FILE_BYTES_MAX + 1 - size),
          null,
        );
        if (!read) break;
        size += read;
        hash.update(bytes.subarray(0, read));
      }
      return size <= TASKSPACE_FILE_BYTES_MAX && hash.digest("hex") === intent.contentHash
        ? "matching-content"
        : "different-content";
    } finally {
      closeSync(fd);
    }
  } catch {
    return "unreadable";
  }
}

export async function pendingTaskspaceFileOperations(db: DB, root: string) {
  const pending = and(
    eq(localFileOperationTable.kind, "taskspace.file"),
    eq(localFileOperationTable.state, "pending"),
  );
  const [row] = await db.select({ total: count() }).from(localFileOperationTable).where(pending);
  const operations = await db
    .select()
    .from(localFileOperationTable)
    .where(pending)
    .orderBy(localFileOperationTable.createdAt, localFileOperationTable.id)
    .limit(5);
  return {
    total: row?.total ?? 0,
    named: operations.map((operation) => ({
      id: operation.id,
      taskspaceId: operation.taskspaceId,
      observation: inspectTaskspaceFileOperation(operation, root),
    })),
  };
}
