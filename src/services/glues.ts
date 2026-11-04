import type { DB } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { glueNamespaceCards, unglueNamespaceCards } from "../db/api/glue.js";
import { requireStringArray } from "./validation.js";
import { rejectBatch } from "./rejection.js";

export async function create(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const cardIds = requireStringArray(body, "cardIds", 2);
  const result = await glueNamespaceCards({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return { glueId: result.glueId, clearedCardIds: result.clearedCardIds };
}
export async function remove(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const cardIds = requireStringArray(body, "cardIds");
  const result = await unglueNamespaceCards({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return { ok: true as const, clearedCardIds: result.clearedCardIds };
}
