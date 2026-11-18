import { join, dirname, resolve } from "node:path";
import { withReadTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import { getTaskspace } from "../../../db/api/taskspace.js";
import { getNamespace } from "../../../db/api/namespace.js";
import { directoryEvidence, type DirectoryIdentity } from "../taskspace-directory-operations.js";
import { TaskspaceFilesError } from "../taskspace-files.js";
import { directoryRemovalError } from "../taskspace-directory.js";
import { journalLocalOperation } from "./journal-operation.js";
import { taskspaceLayoutPaths } from "../taskspace-layout-paths.js";
import { taskspacePathIssue } from "../taskspace-path.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import { isStrictlyInside } from "../fs-paths.js";

type Snapshot = NonNullable<Awaited<ReturnType<typeof getTaskspace>>>;
export function taskspaceDirectorySnapshot(record: Snapshot) {
  if (
    !Number.isSafeInteger(record.createdAt.getTime()) ||
    !Number.isSafeInteger(record.updatedAt.getTime())
  )
    throw new TaskspaceFilesError("stale", "Taskspace timestamps cannot be recorded safely");
  return {
    id: record.id,
    namespaceId: record.namespaceId,
    scopeId: record.scopeId,
    name: record.name,
    path: record.path,
    pathKind: record.pathKind,
    createdAt: record.createdAt.getTime(),
    updatedAt: record.updatedAt.getTime(),
  };
}

/** Recheck the shared identity and attachment without overwriting later edits. */
async function guard(tx: Tx | ReadTx, namespaceId: string, original: Snapshot) {
  const current = await getTaskspace({ db: tx, taskspaceId: original.id });
  if (
    !(await getNamespace({ db: tx, namespaceId })) ||
    !current ||
    JSON.stringify(taskspaceDirectorySnapshot(current)) !==
      JSON.stringify(taskspaceDirectorySnapshot(original))
  )
    throw new TaskspaceFilesError(
      "stale",
      "Taskspace changed before the directory operation could finish",
    );
}

export async function journalTaskspaceDirectoryChange<T, R>(
  input: {
    db: DB;
    namespaceId: string;
    root: string;
    original: Snapshot;
    request:
      | { operation: "remove" }
      | { operation: "move"; name: string }
      | { operation: "layout"; targetPath: string };
    recheck: () => Promise<void>;
    pendingOwnedByBatch?: ReadonlySet<string>;
  },
  change: (identity: DirectoryIdentity) => T | Promise<T>,
  commit: (tx: Tx, result: T) => R | Promise<R>,
): Promise<R> {
  const { db, namespaceId, root, original, request } = input;
  const path = original.path;
  if (!path || original.pathKind !== "workspace_relative")
    throw new TaskspaceFilesError("invalid-path", "Taskspace directory is not managed");
  if (request.operation === "layout") {
    const destination = resolve(root, request.targetPath);
    const settings = resolve(root, ".kozane");
    if (
      taskspacePathIssue(request.targetPath, "workspace_relative") ||
      !isStrictlyInside(resolve(root), destination) ||
      destination === settings ||
      isStrictlyInside(settings, destination)
    )
      throw new TaskspaceFilesError(
        "invalid-path",
        "Layout destination must stay inside the workspace and outside its settings",
      );
  }
  const evidence = directoryEvidence(root, path, original.id);
  if (evidence.state !== "owned") {
    if (request.operation === "remove") throw directoryRemovalError(original.id);
    throw new TaskspaceFilesError("forbidden", "Kozane did not create this directory");
  }
  const intent = JSON.stringify({
    ...request,
    before: taskspaceDirectorySnapshot(original),
    directory: evidence.identity,
    ...(request.operation === "move" && { targetPath: join(dirname(path), request.name) }),
    ...(request.operation === "layout" && {
      paths: taskspaceLayoutPaths(root, path, request.targetPath, original.id),
    }),
  });
  return journalLocalOperation(
    db,
    {
      kind: "taskspace.directory",
      namespaceId,
      taskspaceId: original.id,
      path,
      pathKind: "workspace_relative",
      intent,
    },
    async () => {
      await input.recheck();
      await withReadTx(db, (tx) => guard(tx, namespaceId, original));
      const current = directoryEvidence(root, path, original.id);
      if (
        current.state !== "owned" ||
        JSON.stringify(current.identity) !== JSON.stringify(evidence.identity)
      )
        throw new TaskspaceFilesError("stale", "Taskspace directory changed before the operation");
      return change(evidence.identity);
    },
    async (tx, result) => {
      await guard(tx, namespaceId, original);
      const target =
        request.operation === "layout"
          ? request.targetPath
          : request.operation === "move"
            ? join(dirname(path), request.name)
            : path;
      const current = directoryEvidence(root, target, original.id);
      if (
        request.operation === "remove"
          ? current.state !== "absent"
          : current.state !== "owned" ||
            JSON.stringify(current.identity) !== JSON.stringify(evidence.identity)
      )
        throw new TaskspaceFilesError("stale", "Taskspace directory changed before confirmation");
      return commit(tx, result);
    },
    async (tx) => {
      await guard(tx, namespaceId, original);
      if (request.operation === "layout") {
        const pending = await tx
          .select({ id: localFileOperationTable.id })
          .from(localFileOperationTable)
          .where(eq(localFileOperationTable.state, "pending"))
          .limit((input.pendingOwnedByBatch?.size ?? 0) + 1);
        if (pending.some(({ id }) => !input.pendingOwnedByBatch?.has(id)))
          throw new TaskspaceFilesError(
            "stale",
            "Inspect pending local filesystem operations before changing the layout",
          );
      }
    },
  );
}
