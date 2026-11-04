import { prepareInput } from "./prepare-input.js";
import type { DB } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import {
  createNamespace,
  getAllNamespaces,
  getNamespace,
  deleteNamespace,
  setDefaultNamespace,
} from "../db/api/namespace.js";
import { requireBoundedName } from "./validation.js";
import { NotFoundError } from "./errors.js";

export async function create(db: DB, _context: ServiceContext, input: Record<string, unknown>) {
  input = prepareInput(input);
  const name = requireBoundedName(input);
  const id = await createNamespace({ db, name });
  return { id, name, isDefault: false };
}
export async function list(db: DB, _context: ServiceContext) {
  return getAllNamespaces({ db });
}
export async function get(db: DB, _context: ServiceContext, namespaceId: string) {
  const row = await getNamespace({ db, namespaceId });
  if (!row) throw new NotFoundError("Namespace");
  return row;
}
export async function remove(db: DB, _context: ServiceContext, namespaceId: string) {
  await deleteNamespace({ db, namespaceId });
  return { ok: true as const };
}
export async function setDefault(db: DB, _context: ServiceContext, namespaceId: string) {
  await setDefaultNamespace({ db, namespaceId });
  return { ok: true as const };
}
