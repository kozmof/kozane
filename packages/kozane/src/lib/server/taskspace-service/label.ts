import type { DB } from "../../../db/database.js";
import { withTx } from "../../../db/database.js";
import { getTaskspace } from "../../../db/api/taskspace.js";
import { renameInTx } from "../../../services/taskspaces.js";
import { createServiceContext } from "../../../services/context.js";
import { NotFoundError } from "../../../services/errors.js";
import { oneAtATime } from "./queue.js";

const context = createServiceContext();

/** Change the shared label and read this device's attachment for the existing client reply. */
export function renameTaskspaceLabel(
  locals: { db: DB },
  params: { namespaceId: string; taskspaceId: string },
  body: Record<string, unknown>,
) {
  return oneAtATime(params.taskspaceId, () =>
    withTx(locals.db, async (db) => {
      const shared = await renameInTx(db, context, params.namespaceId, params.taskspaceId, body);
      // Keep response assembly in the same transaction so a failed read cannot publish
      // an error after the label has already committed.
      const host = await getTaskspace({ db, taskspaceId: shared.id });
      if (!host) throw new NotFoundError("Taskspace");
      return { id: shared.id, name: shared.name, path: host.path, pathKind: host.pathKind };
    }),
  );
}
