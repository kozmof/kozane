export type { NamespaceCreateInput } from "./inputs.js";
import { prepareInput } from "./prepare-input.js";
import { withTx, type DB, type Tx } from "../database.js";
import { withActionService } from "../actions/service-frame.js";
import type { ServiceContext } from "./context.js";
import {
  createNamespaceInTx,
  getAllNamespaces,
  getNamespace,
  deleteNamespaceInTx,
  setDefaultNamespaceInTx,
  updateNamespaceName,
} from "../api/namespace.js";
import { requireBoundedName } from "./validation.js";
import { NotFoundError } from "./errors.js";

export async function create(db: DB, context: ServiceContext, input: Record<string, unknown>) {
  const prepared = prepareInput(input);
  return withTx(db, (tx) => createInTx(tx, context, prepared));
}
export function createInTx(db: Tx, _context: ServiceContext, input: Record<string, unknown>) {
  return withActionService(db, async () => {
    input = prepareInput(input);
    const name = requireBoundedName(input);
    const id = await createNamespaceInTx({ db, name });
    return { id, name, isDefault: false };
  });
}
export async function rename(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  input: Record<string, unknown>,
) {
  const prepared = prepareInput(input);
  return withTx(db, (tx) => renameInTx(tx, context, namespaceId, prepared));
}
export function renameInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  input: Record<string, unknown>,
) {
  return withActionService(db, async () => {
    const name = requireBoundedName(prepareInput(input));
    await updateNamespaceName({ db, namespaceId, name });
    return { ok: true as const };
  });
}
export async function list(db: DB, _context: ServiceContext) {
  return getAllNamespaces({ db });
}
export async function get(db: DB, _context: ServiceContext, namespaceId: string) {
  const row = await getNamespace({ db, namespaceId });
  if (!row) throw new NotFoundError("Namespace");
  return row;
}
export async function remove(db: DB, context: ServiceContext, namespaceId: string) {
  return withTx(db, (tx) => removeInTx(tx, context, namespaceId));
}
export function removeInTx(db: Tx, _context: ServiceContext, namespaceId: string) {
  return withActionService(db, async () => {
    await deleteNamespaceInTx({ db, namespaceId });
    return { ok: true as const };
  });
}
export async function setDefault(db: DB, context: ServiceContext, namespaceId: string) {
  return withTx(db, (tx) => setDefaultInTx(tx, context, namespaceId));
}
export function setDefaultInTx(db: Tx, _context: ServiceContext, namespaceId: string) {
  return withActionService(db, async () => {
    await setDefaultNamespaceInTx({ db, namespaceId });
    return { ok: true as const };
  });
}
