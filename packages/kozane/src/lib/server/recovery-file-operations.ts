/** Bounded, read-only observations of current pending evidence in a staged complete recovery. */
import { resolve } from "node:path";
import type { DB } from "../../db/database.js";
import {
  inspectPendingRecoveryFileOperations,
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
  type LocalRecoveryIdentity,
  type PendingRecoveryFileOperationOptions,
  type PendingRecoveryFileOperationPage,
} from "@kozane/core/recovery";
import type { LocalFileOperationEvidence } from "../local-file-operation-evidence.js";
import { inspectLocalClaim } from "./local-file-operations.js";
import { inspectTaskspaceFileOperation } from "./taskspace-file-operations.js";
import { inspectTaskspaceDirectoryOperation } from "./taskspace-directory-operations.js";
type Row = PendingRecoveryFileOperationPage["operations"][number];
type Observation =
  | ReturnType<typeof inspectLocalClaim>
  | ReturnType<typeof inspectTaskspaceFileOperation>
  | ReturnType<typeof inspectTaskspaceDirectoryOperation>
  | "absolute-path-not-inspected"
  | "unsupported-record";
export interface StagedRecoveryFileOperationReport extends PendingRecoveryFileOperationPage {
  readonly observations: readonly {
    readonly record: Row;
    readonly observation: Observation;
  }[];
}
function evidence(row: Row): LocalFileOperationEvidence | null {
  const text = (key: string) => (row[key]?.[0] === "text" ? row[key][1] : null);
  const kind = text("kind"),
    pathKind = text("path_kind"),
    taskspaceId = text("taskspace_id"),
    namespaceId = text("namespace_id"),
    path = text("path"),
    intent = text("intent");
  if (
    !["taskspace.claim", "taskspace.file", "taskspace.directory"].includes(kind ?? "") ||
    row.version?.[0] !== "integer" ||
    row.version[1] !== "1" ||
    (pathKind !== "absolute" && pathKind !== "workspace_relative") ||
    taskspaceId === null ||
    namespaceId === null ||
    path === null ||
    intent === null
  )
    return null;
  return {
    kind: kind as LocalFileOperationEvidence["kind"],
    version: 1,
    taskspaceId,
    namespaceId,
    path,
    pathKind,
    intent,
  };
}
/** Observations acknowledge neither completion nor activation. Never perform journal confirmation or filesystem mutations. */
export async function inspectStagedRecoveryFileOperations(
  options: PendingRecoveryFileOperationOptions & {
    db: DB;
    root: string;
    checkpoint: unknown;
    expected: LocalRecoveryIdentity;
    allowAbsolutePaths?: boolean;
  },
): Promise<StagedRecoveryFileOperationReport> {
  const { db, root, limit, offset } = options,
    allowAbsolutePaths =
      options.allowAbsolutePaths === undefined ? false : options.allowAbsolutePaths;
  if (typeof root !== "string" || !root || root.includes("\0"))
    throw new Error("Recovery inspection requires a workspace root");
  if (typeof allowAbsolutePaths !== "boolean")
    throw new Error("Recovery inspection requires an explicit absolute-path policy");
  const base = resolve(root),
    expected = parseLocalRecoveryIdentity(options.expected),
    checkpoint = parseRecoveryBundleCheckpoint(options.checkpoint);
  const page = await inspectPendingRecoveryFileOperations(db, checkpoint, expected, {
    limit,
    offset,
  });
  const observations = Object.freeze(
    page.operations.map((record) => {
      const operation = evidence(record);
      let observation: Observation;
      if (!operation) observation = "unsupported-record";
      else if (operation.pathKind === "absolute" && !allowAbsolutePaths)
        observation = "absolute-path-not-inspected";
      else if (operation.kind === "taskspace.claim")
        observation = inspectLocalClaim(operation, base);
      else if (operation.kind === "taskspace.file")
        observation = inspectTaskspaceFileOperation(operation, base);
      else observation = inspectTaskspaceDirectoryOperation(operation, base);
      return Object.freeze({ record, observation });
    }),
  );
  const current = await inspectPendingRecoveryFileOperations(db, checkpoint, expected, {
    limit,
    offset,
  });
  if (JSON.stringify(current) !== JSON.stringify(page))
    throw new Error("Pending recovery evidence changed during inspection");
  return Object.freeze({ ...page, observations });
}
