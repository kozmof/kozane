import { join, dirname, resolve } from "node:path";
import { withReadTx, type DB, type ReadTx, type Tx } from "../../../db/database.js";
import type { getTaskspace } from "../../../db/api/taskspace.js";
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
import {
  taskspaceDirectorySnapshot,
  readDirectorySnapshot,
  readDirectoryAttachment,
  sameDirectorySnapshot,
  verifyDirectoryPublication,
  type DirectorySnapshot,
} from "./directory-state.js";
import { inspectTaskspaceDirectoryOperation } from "../taskspace-directory-operations.js";
export { taskspaceDirectorySnapshot } from "./directory-state.js";

type Snapshot = NonNullable<Awaited<ReturnType<typeof getTaskspace>>>;

/** Recheck the shared identity and attachment without overwriting later edits. */
async function guard(tx: Tx | ReadTx, namespaceId: string, original: DirectorySnapshot) {
  const current = await readDirectorySnapshot(tx, original.id);
  if (
    !(await getNamespace({ db: tx, namespaceId })) ||
    !current ||
    !sameDirectorySnapshot(current, original)
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
  change: (identity: Readonly<DirectoryIdentity>) => T | Promise<T>,
  commit: (tx: Tx, result: T) => R | Promise<R>,
): Promise<R> {
  const { db, namespaceId, root, recheck } = input;
  const original = Object.freeze(taskspaceDirectorySnapshot(input.original));
  const request = Object.freeze({ ...input.request });
  const pendingOwnedByBatch = new Set(input.pendingOwnedByBatch);
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
  const identity = Object.freeze({ ...evidence.identity });
  const intent = JSON.stringify({
    ...request,
    before: original,
    directory: identity,
    ...(request.operation === "move" && { targetPath: join(dirname(path), request.name) }),
    ...(request.operation === "layout" && {
      paths: taskspaceLayoutPaths(root, path, request.targetPath, original.id),
    }),
  });
  const journal = Object.freeze({
    kind: "taskspace.directory" as const,
    version: 1,
    namespaceId,
    taskspaceId: original.id,
    path,
    pathKind: "workspace_relative" as const,
    intent,
  });
  const published = await journalLocalOperation(
    db,
    journal,
    async () => {
      await recheck();
      await withReadTx(db, (tx) => guard(tx, namespaceId, original));
      const current = directoryEvidence(root, path, original.id);
      if (
        current.state !== "owned" ||
        JSON.stringify(current.identity) !== JSON.stringify(identity)
      )
        throw new TaskspaceFilesError("stale", "Taskspace directory changed before the operation");
      return change(identity);
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
            JSON.stringify(current.identity) !== JSON.stringify(identity)
      )
        throw new TaskspaceFilesError("stale", "Taskspace directory changed before confirmation");
      const attachment = await readDirectoryAttachment(tx, original.id);
      if (!attachment) throw new TaskspaceFilesError("stale", "Directory attachment is missing");
      const response = await commit(tx, result);
      const expected = { ...original };
      const expectedAttachment = { ...attachment };
      if (request.operation !== "remove") {
        expected.path = target;
        expectedAttachment.path = target;
        if (request.operation === "move") {
          expected.name = request.name;
          const changed = await readDirectorySnapshot(tx, original.id);
          if (!changed) throw new Error("Taskspace disappeared during directory publication");
          expected.updatedAt = changed.updatedAt;
        }
      }
      return { response, expected, attachment: expectedAttachment };
    },
    async (tx) => {
      await guard(tx, namespaceId, original);
      if (request.operation === "layout") {
        const pending = await tx
          .select({ id: localFileOperationTable.id })
          .from(localFileOperationTable)
          .where(eq(localFileOperationTable.state, "pending"))
          .limit(pendingOwnedByBatch.size + 1);
        if (pending.some(({ id }) => !pendingOwnedByBatch.has(id)))
          throw new TaskspaceFilesError(
            "stale",
            "Inspect pending local filesystem operations before changing the layout",
          );
      }
    },
    async (tx, publication) => {
      await verifyDirectoryPublication(
        tx,
        namespaceId,
        request.operation,
        publication.expected,
        publication.attachment,
      );
      const observation = inspectTaskspaceDirectoryOperation(journal, root);
      if (observation !== (request.operation === "remove" ? "source-absent" : "target-only"))
        throw new TaskspaceFilesError(
          "stale",
          `Directory outcome changed before commit: ${observation}`,
        );
    },
  );
  return published.response;
}
