import { withActionService } from "../actions/service-frame.js";
export type { PartitionCreateInput, PartitionRenameInput } from "./inputs.js";
import { prepareInput } from "./prepare-input.js";
import { withTx } from "../database.js";
import type { DB, Tx } from "../database.js";
import type { ServiceContext } from "./context.js";
import { requireBoundedName } from "./validation.js";
import { ConflictError } from "./errors.js";
import { isUniqueConstraintError } from "../api/utils.js";
import { addPartition, updatePartitionName } from "../api/partition.js";
import { deletePartitionWithReassignInTx } from "../api/composite.js";
export function createInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  return withActionService(db, async () => {
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
  });
}
export function renameInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  partitionId: string,
  body: Record<string, unknown>,
) {
  return withActionService(db, async () => {
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
  });
}
export async function remove(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  partitionId: string,
) {
  return withTx(db, (tx) => removeInTx(tx, context, namespaceId, partitionId));
}
export function removeInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  partitionId: string,
) {
  return withActionService(db, async () => {
    const result = await deletePartitionWithReassignInTx({ db, namespaceId, partitionId });
    return { ok: true as const, ...result };
  });
}

export async function create(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => createInTx(tx, context, namespaceId, prepared));
}
export async function rename(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  partitionId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => renameInTx(tx, context, namespaceId, partitionId, prepared));
}
