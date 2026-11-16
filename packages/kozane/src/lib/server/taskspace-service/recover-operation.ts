import { eq } from "drizzle-orm";
import { withReadTx, type DB } from "../../../db/database.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { recoverLocalClaim } from "./recover-claim.js";
import { recoverDirectoryOperation } from "./recover-directory.js";
import { recoverFileOperation } from "./recover-file.js";

/** Select a known recovery procedure; each procedure rechecks its own operation kind. */
export async function recoverTaskspaceOperation(
  db: DB,
  root: string,
  operationId: string,
  apply = false,
) {
  const operation = await withReadTx(db, (tx) =>
    tx
      .select({ kind: localFileOperationTable.kind })
      .from(localFileOperationTable)
      .where(eq(localFileOperationTable.id, operationId))
      .get(),
  );
  if (!operation) throw new Error("Local filesystem operation not found");
  switch (operation.kind) {
    case "taskspace.claim":
      return { ...(await recoverLocalClaim(db, root, operationId, apply)), intent: null };
    case "taskspace.directory":
      return recoverDirectoryOperation(db, root, operationId, apply);
    case "taskspace.file":
      return recoverFileOperation(db, root, operationId, apply);
  }
}
