/** Shared taskspace identity and labels. Local attachments belong to the host. */
import { and, eq, isNull, or } from "drizzle-orm";
import { withTx, type DB, type Tx } from "../database.js";
import { namespaceTable, scopeTable, taskspaceTable } from "../schema.js";
import type { SharedTaskspace } from "../database-types.js";
import {
  addTaskspaceInTx,
  updateTaskspaceNameInTx,
  deleteTaskspaceInTx,
} from "../api/taskspace.js";
import { withActionService } from "../actions/service-frame.js";
import type { ServiceContext } from "./context.js";
import { prepareInput } from "./prepare-input.js";
import { requireBoundedName, requireString } from "./validation.js";
import { NotFoundError, ValidationError } from "./errors.js";
export type { TaskspaceCreateInput, TaskspaceRenameInput } from "./inputs.js";

function body(input: Record<string, unknown>, fields: readonly string[]) {
  const copy = prepareInput(input);
  if (
    !copy ||
    typeof copy !== "object" ||
    Array.isArray(copy) ||
    Object.keys(copy).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(copy, field))
  )
    throw new ValidationError(`Taskspace input requires exactly ${fields.join(", ")}`);
  return copy;
}
async function requireNamespace(db: Tx, namespaceId: string) {
  const row = await db
    .select({ id: namespaceTable.id })
    .from(namespaceTable)
    .where(eq(namespaceTable.id, namespaceId))
    .get();
  if (!row) throw new NotFoundError("Namespace");
}
async function requireVisible(
  db: Tx,
  namespaceId: string,
  taskspaceId: string,
): Promise<SharedTaskspace> {
  await requireNamespace(db, namespaceId);
  const row = await db
    .select()
    .from(taskspaceTable)
    .where(
      and(
        eq(taskspaceTable.id, taskspaceId),
        or(eq(taskspaceTable.namespaceId, namespaceId), isNull(taskspaceTable.namespaceId)),
      ),
    )
    .get();
  if (!row) throw new NotFoundError("Taskspace");
  return row;
}
export async function create(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  input: Record<string, unknown>,
) {
  const copy = prepareInput(input);
  return withTx(db, (tx) => createInTx(tx, context, namespaceId, copy));
}
export function createInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  input: Record<string, unknown>,
) {
  return withActionService(db, async () => {
    const copy = body(input, ["name", "scopeId"]);
    const name = requireBoundedName(copy);
    const scopeId = requireString(copy, "scopeId");
    await requireNamespace(db, namespaceId);
    if (
      !(await db
        .select({ id: scopeTable.id })
        .from(scopeTable)
        .where(eq(scopeTable.id, scopeId))
        .get())
    )
      throw new NotFoundError("Scope");
    const id = await addTaskspaceInTx({ db, namespaceId, scopeId, name });
    return requireVisible(db, namespaceId, id);
  });
}
export async function rename(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  taskspaceId: string,
  input: Record<string, unknown>,
) {
  const copy = prepareInput(input);
  return withTx(db, (tx) => renameInTx(tx, context, namespaceId, taskspaceId, copy));
}
export function renameInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  taskspaceId: string,
  input: Record<string, unknown>,
) {
  return withActionService(db, async () => {
    const name = requireBoundedName(body(input, ["name"]));
    await requireVisible(db, namespaceId, taskspaceId);
    await updateTaskspaceNameInTx({ db, taskspaceId, name });
    return requireVisible(db, namespaceId, taskspaceId);
  });
}
export function remove(db: DB, context: ServiceContext, namespaceId: string, taskspaceId: string) {
  return withTx(db, (tx) => removeInTx(tx, context, namespaceId, taskspaceId));
}
export function removeInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  taskspaceId: string,
) {
  return withActionService(db, async () => {
    await requireVisible(db, namespaceId, taskspaceId);
    await deleteTaskspaceInTx({ db, taskspaceId });
    return { ok: true as const };
  });
}
