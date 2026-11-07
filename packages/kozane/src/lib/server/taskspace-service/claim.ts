import { addTaskspace, deleteTaskspace } from "../../../db/api/taskspace.js";
import { claimTaskspaceDirectory } from "../taskspace-directory.js";

type RecordInput = Parameters<typeof addTaskspace>[0];
type DirectoryInput = Omit<
  Parameters<typeof claimTaskspaceDirectory>[0],
  "taskspaceId" | "namespaceId"
>;

export class TaskspaceClaimError extends Error {
  constructor(cause: unknown) {
    super("Taskspace directory claim failed", { cause });
  }
}

/** Compensate the database record if claiming its directory fails. Adapter policy stays with callers. */
export async function claimRecordedTaskspace(
  record: RecordInput & { namespaceId: string },
  directory: DirectoryInput,
) {
  const id = await addTaskspace(record);
  try {
    claimTaskspaceDirectory({ ...directory, taskspaceId: id, namespaceId: record.namespaceId });
  } catch (error) {
    await deleteTaskspace({ db: record.db, taskspaceId: id });
    throw new TaskspaceClaimError(error);
  }
  return id;
}
