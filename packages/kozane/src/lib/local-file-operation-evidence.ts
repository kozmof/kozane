/** Fields used for read-only disk observations. Journal timestamps remain exact stored evidence. */
import type { localFileOperationTable } from "../db/schema.js";
export type LocalFileOperationEvidence = Pick<
  typeof localFileOperationTable.$inferSelect,
  "kind" | "version" | "taskspaceId" | "namespaceId" | "path" | "pathKind" | "intent"
>;
