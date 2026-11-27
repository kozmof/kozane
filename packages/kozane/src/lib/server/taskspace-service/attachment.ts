import { eq, sql } from "drizzle-orm";
import type { AnyDB } from "../../../db/database.js";
import { taskspaceTable, taskspaceLocalTable } from "../../../db/schema.js";
import type { PathKind } from "../../constants.js";

function attachmentRows(db: AnyDB) {
  return db
    .select({
      id: taskspaceTable.id,
      path: taskspaceLocalTable.path,
      pathKind: sql<PathKind>`coalesce(${taskspaceLocalTable.pathKind}, 'workspace_relative')`,
    })
    .from(taskspaceTable)
    .leftJoin(taskspaceLocalTable, eq(taskspaceLocalTable.taskspaceId, taskspaceTable.id));
}

/** Read the shared identity and local path without decoding unrelated timestamps. */
export function readTaskspaceAttachment(db: AnyDB, taskspaceId: string) {
  return attachmentRows(db).where(eq(taskspaceTable.id, taskspaceId)).get();
}

/** Check recorded nesting without reading any taskspace's shared or local timestamps. */
export async function readTaskspaceAttachments(db: AnyDB) {
  return attachmentRows(db);
}
