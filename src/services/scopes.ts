import { deleteScope } from "../db/api/scope.js";
import { withTx } from "../db/database.js";
import { prepareInput } from "./prepare-input.js";
import type { DB, Tx } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { addScope, getScope, updateScopeName, deleteScopeFromNamespace } from "../db/api/scope.js";
import { addScopeMembersInTx, removeScopeMembersFromNamespaceInTx } from "../db/api/scope-rel.js";
import { addScopeArea, moveScopeArea, deleteScopeArea } from "../db/api/scope-area.js";
import { isUniqueConstraintError } from "../db/api/utils.js";
import { requireBoundedName, requireStringArray, optionalNumber } from "./validation.js";
import { rejectBatch } from "./rejection.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { clamp, SCOPE_AREA_MIN_SIZE, type BoardRect } from "../lib/constants.js";
function missing(message: string): NotFoundError {
  const error = new NotFoundError("Scope");
  error.message = message;
  return error;
}
function readAreaRect(body: Record<string, unknown>): BoardRect {
  const posX = optionalNumber(body, "posX"),
    posY = optionalNumber(body, "posY"),
    width = optionalNumber(body, "width"),
    height = optionalNumber(body, "height");
  if (posX === undefined || posY === undefined || width === undefined || height === undefined)
    throw new ValidationError("posX, posY, width and height are required");
  return { posX, posY, width, height };
}
function clampRect(rect: BoardRect, context: ServiceContext): BoardRect {
  const width = Math.round(clamp(rect.width, SCOPE_AREA_MIN_SIZE, context.canvasWidth));
  const height = Math.round(clamp(rect.height, SCOPE_AREA_MIN_SIZE, context.canvasHeight));
  return {
    width,
    height,
    posX: Math.round(clamp(rect.posX, 0, Math.max(0, context.canvasWidth - width))),
    posY: Math.round(clamp(rect.posY, 0, Math.max(0, context.canvasHeight - height))),
  };
}

export async function create(db: DB, _context: ServiceContext, body: Record<string, unknown>) {
  body = prepareInput(body);
  const name = requireBoundedName(body);

  try {
    const id = await addScope({ db, name });
    return { id };
  } catch (e) {
    if (isUniqueConstraintError(e))
      throw new ConflictError(`A scope named "${name}" already exists`);
    throw e;
  }
}

export async function rename(
  db: DB,
  _context: ServiceContext,
  _namespaceId: string,
  scopeId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const name = requireBoundedName(body);

  if (!(await getScope({ db, scopeId: scopeId }))) throw missing("Scope not found");
  try {
    await updateScopeName({ db, scopeId: scopeId, name });
  } catch (e) {
    if (isUniqueConstraintError(e))
      throw new ConflictError(`A scope named "${name}" already exists`);
    throw e;
  }
  return { id: scopeId, name };
}

export async function remove(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  scopeId: string,
) {
  const ok = await deleteScopeFromNamespace({ db, namespaceId, scopeId });
  if (!ok) throw missing("Scope not found in namespace");
  return { ok: true };
}

export async function addMembersInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardIds = requireStringArray(body, "cardIds");

  const result = await addScopeMembersInTx({ db, scopeId, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);

  return { ok: true };
}

export async function removeMembersInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardIds = requireStringArray(body, "cardIds");

  const result = await removeScopeMembersFromNamespaceInTx({ db, scopeId, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);

  return { ok: true };
}

export async function createArea(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const rect = readAreaRect(body);

  // The whole stored row, so a client that drew the frame where the pointer let go cannot
  // keep it at an unclamped rectangle until the next snapshot poll corrects it.
  return await addScopeArea({ db, namespaceId, scopeId, ...clampRect(rect, context) });
}

export async function updateArea(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  areaId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const rect = readAreaRect(body);

  return await moveScopeArea({ db, namespaceId, scopeId, areaId, ...clampRect(rect, context) });
}

export async function removeArea(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  areaId: string,
) {
  await deleteScopeArea({ db, namespaceId, scopeId, areaId });
  return { ok: true };
}

export async function addMembers(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => addMembersInTx(tx, context, namespaceId, scopeId, prepared));
}

export async function removeMembers(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  scopeId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => removeMembersInTx(tx, context, namespaceId, scopeId, prepared));
}

/** Workspace deletion differs from removing one board's scope placement. */
export async function removeWorkspaceInTx(tx: Tx, _context: ServiceContext, scopeId: string) {
  await deleteScope({ db: tx, scopeId });
  return { ok: true as const };
}
export async function removeWorkspace(db: DB, context: ServiceContext, scopeId: string) {
  return withTx(db, (tx) => removeWorkspaceInTx(tx, context, scopeId));
}
