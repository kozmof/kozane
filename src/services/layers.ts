import { withTx } from "../db/database.js";
import { prepareInput } from "./prepare-input.js";
import type { DB, Tx } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { requireBoundedName } from "./validation.js";
import { ConflictError } from "./errors.js";
import { isUniqueConstraintError } from "../db/api/utils.js";
import { addLayer, updateLayerName } from "../db/api/layer.js";
import { deleteLayerWithReassign } from "../db/api/composite.js";
export async function create(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const name = requireBoundedName(body);
  try {
    const { id, position } = await addLayer({ db, namespaceId, name });
    return { id, name, position, isDefault: false };
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new ConflictError(`A layer named "${name}" already exists`, { cause: error });
    throw error;
  }
}
export async function rename(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  layerId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const name = requireBoundedName(body);
  try {
    await updateLayerName({ db, namespaceId, layerId, name });
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new ConflictError(`A layer named "${name}" already exists`, { cause: error });
    throw error;
  }
  return { ok: true as const };
}
export async function remove(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  layerId: string,
) {
  const result = await deleteLayerWithReassign({ db, namespaceId, layerId });
  return { ok: true as const, ...result };
}

import { reorderLayersInTx, type ReorderRejection } from "../db/api/layer.js";
import { requireStringArray } from "./validation.js";
import { ValidationError } from "./errors.js";
const REORDER_REJECTION_MESSAGE: Record<ReorderRejection, string> = {
  duplicate: "layerIds must not name the same layer twice",
  stale: "The namespace's layers changed elsewhere. Reload to see the current order.",
  foreign: "layerIds must only name layers of this namespace",
};
export async function reorderInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const layerIds = requireStringArray(body, "layerIds");
  const result = await reorderLayersInTx({ db, namespaceId, layerIds });
  if (!result.ok) throw new ValidationError(REORDER_REJECTION_MESSAGE[result.reason]);
  return { ok: true as const };
}

export async function reorder(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => reorderInTx(tx, context, namespaceId, prepared));
}
