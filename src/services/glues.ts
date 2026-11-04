import { withTx } from "../db/database.js";
import { prepareInput } from "./prepare-input.js";
import type { DB, Tx } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { glueNamespaceCardsInTx, unglueNamespaceCardsInTx } from "../db/api/glue.js";
import { requireStringArray } from "./validation.js";
import { rejectBatch } from "./rejection.js";

export async function createInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardIds = requireStringArray(body, "cardIds", 2);
  const result = await glueNamespaceCardsInTx({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return { glueId: result.glueId, clearedCardIds: result.clearedCardIds };
}
export async function removeInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardIds = requireStringArray(body, "cardIds");
  const result = await unglueNamespaceCardsInTx({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return { ok: true as const, clearedCardIds: result.clearedCardIds };
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

export async function remove(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => removeInTx(tx, context, namespaceId, prepared));
}
