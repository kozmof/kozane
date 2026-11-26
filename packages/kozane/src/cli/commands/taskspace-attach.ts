import { resolve } from "node:path";
import { taskspaceTable } from "../../db/schema.js";
import { claimExistingTaskspace } from "../../lib/server/taskspace-service/claim-existing.js";
import { LocalOperationError } from "../../lib/server/taskspace-service/journal-operation.js";
import { storedLocation } from "../../lib/server/taskspace-path.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export async function taskspaceAttach(
  requestedId: string,
  options: { dir: string; namespace?: string },
) {
  await runWorkspaceCommand(async ({ db, root }) => {
    const rows = await db
      .select({ id: taskspaceTable.id, namespaceId: taskspaceTable.namespaceId })
      .from(taskspaceTable);
    const taskspaceId = resolveShortId(
      requestedId,
      rows.map(({ id }) => id),
      "Taskspace",
    );
    const shared = rows.find(({ id }) => id === taskspaceId)!;
    if (shared.namespaceId === null)
      throw Error("Taskspace must belong to a namespace before attaching a directory");
    const namespaceId = options.namespace
      ? await resolveNamespaceId(db, options.namespace)
      : shared.namespaceId;
    const targetDir = resolve(options.dir);
    const location = storedLocation(root, targetDir);
    try {
      await claimExistingTaskspace(
        {
          db,
          namespaceId,
          taskspaceId,
          path: location.storedPath,
          pathKind: location.pathKind,
          lastSeenAt: new Date(),
        },
        {
          workspaceRoot: root,
          targetDir,
          adoptExisting: true,
          parentsInside: false,
          ownIfCreated: false,
        },
      );
    } catch (cause) {
      if (cause instanceof LocalOperationError)
        throw Error(
          `Directory attachment needs recovery. Inspect with kozane taskspace recover ${cause.operationId} before repeating it.`,
          { cause },
        );
      throw cause;
    }
    console.log(
      `Attached ${shortId(
        taskspaceId,
        rows.map(({ id }) => id),
      )} to ${location.storedPath} (${location.pathKind})`,
    );
  });
}
