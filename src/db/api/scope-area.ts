import { scopeAreaTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsNamespace, ScopeArea } from "./types.js";
import { assertFound } from "./utils.js";

type NeedsNamespaceScope = NeedsNamespace & { scopeId: string };

/**
 * The frames drawn on one board, oldest first — uuidv7 ids already hold creation order, and
 * nothing here has another one to offer.
 *
 * Read by the page load and by the once-a-second snapshot poll, through
 * `loadNamespaceSnapshot`. `scope_area_namespace` is what keeps that off a full scan.
 */
export async function getScopeAreasInNamespace({
  db,
  namespaceId,
}: NeedsNamespace): Promise<ScopeArea[]> {
  return db
    .select()
    .from(scopeAreaTable)
    .where(eq(scopeAreaTable.namespaceId, namespaceId))
    .orderBy(asc(scopeAreaTable.id));
}

type SetScopeArea = NeedsNamespaceScope & {
  posX: number;
  posY: number;
  width: number;
  height: number;
};

/**
 * Puts the scope's frame on this board, wherever it was before.
 *
 * One upsert rather than an add and a move, because the two are the same write: the unique
 * index on `(scope_id, namespace_id)` is what makes "there is already a frame here" a conflict
 * to update rather than a second row, and the board has no operation that means "add a frame
 * without knowing whether one is there" — dragging one is the same PUT as creating it.
 *
 * The whole stored row comes back, so a client that drew the frame where the pointer let go
 * can correct it to the clamped rectangle that was kept. Same contract as {@link moveWarp}.
 */
export async function setScopeArea({
  db,
  namespaceId,
  scopeId,
  posX,
  posY,
  width,
  height,
}: SetScopeArea): Promise<ScopeArea> {
  const [row] = await db
    .insert(scopeAreaTable)
    .values({ namespaceId, scopeId, posX, posY, width, height })
    .onConflictDoUpdate({
      target: [scopeAreaTable.scopeId, scopeAreaTable.namespaceId],
      set: { posX, posY, width, height },
    })
    .returning();
  return row;
}

/**
 * Takes the scope's frame off this board. The scope and every card in it are left alone: an
 * area says where a scope is drawn, not what is in it, and a frame removed by accident would
 * otherwise take a membership list with it.
 */
export async function deleteScopeArea({
  db,
  namespaceId,
  scopeId,
}: NeedsNamespaceScope): Promise<void> {
  const deleted = await db
    .delete(scopeAreaTable)
    .where(and(eq(scopeAreaTable.namespaceId, namespaceId), eq(scopeAreaTable.scopeId, scopeId)))
    .returning({ id: scopeAreaTable.id });
  assertFound(deleted, `ScopeArea namespaceId=${namespaceId} scopeId=${scopeId}`);
}
