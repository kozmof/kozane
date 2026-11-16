import { join, dirname } from "node:path";
import { withReadTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import { getTaskspace } from "../../../db/api/taskspace.js";
import { getNamespace } from "../../../db/api/namespace.js";
import { directoryEvidence } from "../taskspace-directory-operations.js";
import { TaskspaceFilesError } from "../taskspace-files.js";
import { directoryRemovalError } from "../taskspace-directory.js";
import { journalLocalOperation } from "./journal-operation.js";

type Snapshot = NonNullable<Awaited<ReturnType<typeof getTaskspace>>>;
function snapshot(record: Snapshot) {
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
    JSON.stringify(snapshot(current)) !== JSON.stringify(snapshot(original))
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
    request: { operation: "remove" } | { operation: "move"; name: string };
    recheck: () => Promise<void>;
  },
  change: () => T | Promise<T>,
  commit: (tx: Tx, result: T) => R | Promise<R>,
): Promise<R> {
  const { db, namespaceId, root, original, request } = input;
  const path = original.path;
  if (!path || original.pathKind !== "workspace_relative")
    throw new TaskspaceFilesError("invalid-path", "Taskspace directory is not managed");
  const evidence = directoryEvidence(root, path, original.id);
  if (evidence.state !== "owned") {
    if (request.operation === "remove") throw directoryRemovalError(original.id);
    throw new TaskspaceFilesError("forbidden", "Kozane did not create this directory");
  }
  const intent = JSON.stringify({
    ...request,
    before: snapshot(original),
    directory: evidence.identity,
    ...(request.operation === "move" && { targetPath: join(dirname(path), request.name) }),
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
      return change();
    },
    async (tx, result) => {
      await guard(tx, namespaceId, original);
      return commit(tx, result);
    },
    (tx) => guard(tx, namespaceId, original),
  );
}
