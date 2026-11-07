export type { PartitionCreateInput, PartitionRenameInput } from "./inputs.js";
import { prepareInput } from "./prepare-input.js";
import type { DB } from "../database.js";
import type { ServiceContext } from "./context.js";
import { requireBoundedName } from "./validation.js";
import { ConflictError } from "./errors.js";
import { isUniqueConstraintError } from "../../../../src/db/api/utils.js";
import { addPartition, updatePartitionName } from "../../../../src/db/api/partition.js";
import { deletePartitionWithReassign } from "../../../../src/db/api/composite.js";
export async function create(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const name = requireBoundedName(body);
  try {
    const id = await addPartition({ db, namespaceId, name });
    return { id };
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new ConflictError(`A partition named "${name}" already exists`, { cause: error });
    throw error;
  }
}
export async function rename(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  partitionId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const name = requireBoundedName(body);
  try {
    await updatePartitionName({ db, namespaceId, partitionId, name });
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new ConflictError(`A partition named "${name}" already exists`, { cause: error });
    throw error;
  }
  return { ok: true as const };
}
export async function remove(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  partitionId: string,
) {
  const result = await deletePartitionWithReassign({ db, namespaceId, partitionId });
  return { ok: true as const, ...result };
}
