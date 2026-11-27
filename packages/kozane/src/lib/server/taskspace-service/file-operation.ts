import type { DB } from "../../../db/database.js";
import {
  prepareTaskspaceFileChange,
  type TaskspaceFileChange,
} from "../taskspace-file-operations.js";
import { TaskspaceFilesError } from "../taskspace-files.js";
import { journalLocalOperation } from "./journal-operation.js";
import { taskspaceFileOutcomeIssue } from "./file-outcome.js";
export { LocalOperationError as TaskspaceFileOperationError } from "./journal-operation.js";

/** Called inside the taskspace queue. Filesystem work runs once, between durable boundaries. */
export async function journalTaskspaceFileChange<T>(
  input: {
    db: DB;
    namespaceId: string;
    taskspaceId: string;
    root: string;
    baseDir: string;
    request: TaskspaceFileChange;
    currentBaseDir: () => Promise<string>;
  },
  change: (baseDir: string) => T | Promise<T>,
): Promise<T> {
  const { db, namespaceId, taskspaceId, root, baseDir, currentBaseDir } = input;
  const request = Object.freeze({ ...input.request });
  const prepared = prepareTaskspaceFileChange(root, baseDir, request);
  const evidence = Object.freeze({
    kind: "taskspace.file" as const,
    version: 1,
    namespaceId,
    taskspaceId,
    path: prepared.storedPath,
    pathKind: prepared.pathKind,
    intent: prepared.intent,
  });
  return journalLocalOperation(
    db,
    evidence,
    async () => {
      const currentBase = await currentBaseDir();
      const current = prepareTaskspaceFileChange(root, currentBase, request);
      if (
        current.base !== prepared.base ||
        current.real !== prepared.real ||
        current.intent !== prepared.intent
      )
        throw new TaskspaceFilesError(
          "stale",
          "Taskspace directory changed before the file operation",
        );
      return change(currentBase);
    },
    (_tx, result) => result,
    undefined,
    async (tx) => {
      const issue = await taskspaceFileOutcomeIssue(tx, root, evidence);
      if (issue !== null) throw new TaskspaceFilesError("stale", issue);
    },
  );
}
