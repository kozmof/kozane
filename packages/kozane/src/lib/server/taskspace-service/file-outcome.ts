/** Read current file eligibility and outcome without changing files or decoding timestamps. */
import { eq } from "drizzle-orm";
import type { ReadTx, Tx } from "../../../db/database.js";
import { namespaceTable, taskspaceTable, taskspaceLocalTable } from "../../../db/schema.js";
import type { LocalFileOperationEvidence } from "../../local-file-operation-evidence.js";
import {
  inspectTaskspaceFileRecovery,
  parseTaskspaceFileIntent,
} from "../taskspace-file-operations.js";
import { resolveTaskspacePath } from "../taskspace-path.js";

export async function taskspaceFileOutcomeIssue(
  db: ReadTx | Tx,
  root: string,
  operation: LocalFileOperationEvidence,
) {
  const intent = parseTaskspaceFileIntent(operation);
  if (!intent) return "Invalid recorded file intent";
  const taskspace = await db
    .select({
      namespaceId: taskspaceTable.namespaceId,
      path: taskspaceLocalTable.path,
      pathKind: taskspaceLocalTable.pathKind,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id))
    .where(eq(taskspaceTable.id, operation.taskspaceId))
    .get();
  if (!taskspace) return "Taskspace no longer exists";
  const namespace = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, operation.namespaceId))
    .get();
  if (!namespace) return "Namespace no longer exists";
  if (taskspace.namespaceId !== null && taskspace.namespaceId !== operation.namespaceId)
    return "Taskspace is no longer visible in the recorded namespace";
  const base =
    taskspace.path &&
    taskspace.pathKind &&
    resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
  if (!base) return "Taskspace has no valid directory attachment";
  const observation = inspectTaskspaceFileRecovery(operation, root, base);
  const expected = {
    "create-file": "matching-content",
    "save-file": "matching-content",
    "create-directory": "directory-present",
    "rename-entry": "target-only",
    "remove-entry": "entry-absent",
  }[intent.operation];
  return observation === expected ? null : `File outcome is not verified: ${observation}`;
}
