/** Read-only identity and marker evidence for managed directory moves and removal. */
import {
  closeSync,
  constants,
  lstatSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { and, count, eq } from "drizzle-orm";
import type { DB } from "../../db/database.js";
import { localFileOperationTable } from "../../db/schema.js";
import { TASKSPACE_MARKER_FILE, TASKSPACE_MARKER_KIND } from "../taskspace-marker.js";
import { taskspaceNameIssue } from "../constants.js";
import { contentHash } from "./local-file-operations.js";
import { errorCode, isStrictlyInside } from "./fs-paths.js";
import { taskspacePathIssue } from "./taskspace-path.js";

export type DirectoryIdentity = { dev: string; ino: string; markerHash: string };
type Evidence =
  | { state: "owned"; identity: DirectoryIdentity }
  | { state: "absent" | "unsafe-path" | "foreign-marker" };
type Operation = typeof localFileOperationTable.$inferSelect;

export function directoryEvidence(root: string, storedPath: string, taskspaceId: string): Evidence {
  if (taskspacePathIssue(storedPath, "workspace_relative")) return { state: "unsafe-path" };
  const base = realpathSync(root);
  const path = resolve(base, storedPath);
  if (
    !isStrictlyInside(base, path) ||
    path === join(base, ".kozane") ||
    isStrictlyInside(join(base, ".kozane"), path)
  )
    return { state: "unsafe-path" };
  let parent = base;
  for (const part of relative(base, path).split(sep)) {
    parent = join(parent, part);
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: "unsafe-path" };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { state: "absent" };
      throw error;
    }
  }
  const directory = lstatSync(path, { bigint: true });
  const marker = join(path, TASKSPACE_MARKER_FILE);
  let fd: number;
  try {
    fd = openSync(
      marker,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(errorCode(error) ?? "")) return { state: "foreign-marker" };
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return { state: "foreign-marker" };
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > 65536) return { state: "foreign-marker" };
    const contents = bytes.subarray(0, size);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
    } catch {
      return { state: "foreign-marker" };
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("kind" in value) ||
      value.kind !== TASKSPACE_MARKER_KIND ||
      !("taskspaceId" in value) ||
      value.taskspaceId !== taskspaceId ||
      !("ownsDirectory" in value) ||
      value.ownsDirectory !== true
    )
      return { state: "foreign-marker" };
    const current = lstatSync(path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== directory.dev ||
      current.ino !== directory.ino
    )
      return { state: "unsafe-path" };
    return {
      state: "owned",
      identity: {
        dev: directory.dev.toString(),
        ino: directory.ino.toString(),
        markerHash: contentHash(contents),
      },
    };
  } finally {
    closeSync(fd);
  }
}

export type DirectoryObservation =
  | "invalid-intent"
  | "unsafe-path"
  | "unreadable"
  | "foreign-marker"
  | "different-directory"
  | "source-present"
  | "source-absent"
  | "source-only"
  | "target-only"
  | "both-present"
  | "both-absent";

export function inspectTaskspaceDirectoryOperation(
  operation: Operation,
  root: string,
): DirectoryObservation {
  if (
    operation.kind !== "taskspace.directory" ||
    operation.version !== 1 ||
    operation.pathKind !== "workspace_relative"
  )
    return "invalid-intent";
  try {
    const intent = JSON.parse(operation.intent);
    if (
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      !["move", "remove"].includes(intent.operation) ||
      !intent.before ||
      typeof intent.before !== "object" ||
      !intent.directory ||
      typeof intent.directory.dev !== "string" ||
      typeof intent.directory.ino !== "string" ||
      !/^[0-9]+$/.test(intent.directory.dev) ||
      !/^[0-9]+$/.test(intent.directory.ino) ||
      typeof intent.directory.markerHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(intent.directory.markerHash)
    )
      return "invalid-intent";
    if (
      intent.operation === "move" &&
      (typeof intent.name !== "string" ||
        taskspaceNameIssue(intent.name) ||
        typeof intent.targetPath !== "string" ||
        intent.targetPath !== join(dirname(operation.path), intent.name))
    )
      return "invalid-intent";
    const fields =
      intent.operation === "move"
        ? ["operation", "before", "directory", "name", "targetPath"]
        : ["operation", "before", "directory"];
    if (
      Object.keys(intent).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(intent, field))
    )
      return "invalid-intent";
    const states = [directoryEvidence(root, operation.path, operation.taskspaceId)];
    if (intent.operation === "move")
      states.push(directoryEvidence(root, intent.targetPath, operation.taskspaceId));
    for (const evidence of states) {
      if (evidence.state !== "owned" && evidence.state !== "absent") return evidence.state;
      if (
        evidence.state === "owned" &&
        (evidence.identity.dev !== intent.directory.dev ||
          evidence.identity.ino !== intent.directory.ino ||
          evidence.identity.markerHash !== intent.directory.markerHash)
      )
        return "different-directory";
    }
    const source = states[0].state === "owned";
    if (intent.operation === "remove") return source ? "source-present" : "source-absent";
    const target = states[1].state === "owned";
    return source
      ? target
        ? "both-present"
        : "source-only"
      : target
        ? "target-only"
        : "both-absent";
  } catch (error) {
    return error instanceof SyntaxError ? "invalid-intent" : "unreadable";
  }
}

export async function pendingTaskspaceDirectoryOperations(db: DB, root: string) {
  const pending = and(
    eq(localFileOperationTable.kind, "taskspace.directory"),
    eq(localFileOperationTable.state, "pending"),
  );
  const [row] = await db.select({ total: count() }).from(localFileOperationTable).where(pending);
  const rows = await db
    .select()
    .from(localFileOperationTable)
    .where(pending)
    .orderBy(localFileOperationTable.createdAt, localFileOperationTable.id)
    .limit(5);
  return {
    total: row?.total ?? 0,
    named: rows.map((operation) => ({
      id: operation.id,
      taskspaceId: operation.taskspaceId,
      observation: inspectTaskspaceDirectoryOperation(operation, root),
    })),
  };
}
