import { scopeAreaTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsNamespace, ScopeArea } from "./types.js";
import type { BoardRect } from "../../lib/constants.js";
import { assertFound } from "./utils.js";

type NeedsNamespaceArea = NeedsNamespace & { scopeId: string; areaId: string };
// The board's rectangle, named in `lib/constants/canvas.ts`. Aliased locally because `Rect` is
// what the signatures below read best as, and because this module's callers name the type
// through them rather than by importing it.
type Rect = BoardRect;

/**
 * Read a board's frames in UUIDv7 creation order for page loads and snapshot polls. The
 * namespace index limits the query to this board.
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

type AddScopeArea = NeedsNamespace & { scopeId: string } & Rect;

/** Insert each frame separately so each gets its own ID. */
export async function addScopeArea({
  db,
  namespaceId,
  scopeId,
  posX,
  posY,
  width,
  height,
}: AddScopeArea): Promise<ScopeArea> {
  const [row] = await db
    .insert(scopeAreaTable)
    .values({ namespaceId, scopeId, posX, posY, width, height })
    .returning();
  return row;
}

type MoveScopeArea = NeedsNamespaceArea & Rect;

/** Moving or resizing a frame checks namespace and scope ownership before returning the row. */
export async function moveScopeArea({
  db,
  namespaceId,
  scopeId,
  areaId,
  posX,
  posY,
  width,
  height,
}: MoveScopeArea): Promise<ScopeArea> {
  const updated = await db
    .update(scopeAreaTable)
    .set({ posX, posY, width, height })
    .where(
      and(
        eq(scopeAreaTable.id, areaId),
        eq(scopeAreaTable.namespaceId, namespaceId),
        eq(scopeAreaTable.scopeId, scopeId),
      ),
    )
    .returning();
  assertFound(updated, `ScopeArea namespaceId=${namespaceId} areaId=${areaId}`);
  return updated[0];
}

/** Removing a frame preserves scope membership and other frames. */
export async function deleteScopeArea({
  db,
  namespaceId,
  scopeId,
  areaId,
}: NeedsNamespaceArea): Promise<void> {
  const deleted = await db
    .delete(scopeAreaTable)
    .where(
      and(
        eq(scopeAreaTable.id, areaId),
        eq(scopeAreaTable.namespaceId, namespaceId),
        eq(scopeAreaTable.scopeId, scopeId),
      ),
    )
    .returning({ id: scopeAreaTable.id });
  assertFound(deleted, `ScopeArea namespaceId=${namespaceId} areaId=${areaId}`);
}
