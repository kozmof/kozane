import { eq, sql } from "drizzle-orm";
import type { ReadTx, Tx } from "../../../db/database.js";
import { taskspaceTable, taskspaceLocalTable } from "../../../db/schema.js";
import type { PathKind } from "../../constants.js";

/** Read the shared identity and local path without decoding unrelated timestamps. */
export function readTaskspaceAttachment(db: ReadTx | Tx, taskspaceId: string) {
  return db
    .select({
      id: taskspaceTable.id,
      path: taskspaceLocalTable.path,
      pathKind: sql<PathKind>`coalesce(${taskspaceLocalTable.pathKind}, 'workspace_relative')`,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id))
    .where(eq(taskspaceTable.id, taskspaceId))
    .get();
}
