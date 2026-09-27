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

type AddScopeArea = NeedsNamespace & { scopeId: string } & Rect;

/**
 * Draws another frame for a scope on this board.
 *
 * A plain insert, not an upsert: a scope may be framed in several places at once, so there
 * is nothing here for a second frame to conflict with. Which frame a later move or removal
 * acts on is settled by its own id.
 */
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

/**
 * Puts one frame somewhere else on the board, or makes it another size.
 *
 * The whole stored row comes back, so a caller that drew the frame where the pointer let go
 * can correct it to the clamped rectangle that was kept. Same contract as `moveWarp`.
 *
 * `namespaceId` and `scopeId` are checked alongside the id, which alone would do: the pair is
 * the access boundary, the same way `deleteWarp` checks a namespace it does not need.
 */
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

/**
 * Takes one frame off the board. The scope keeps every card in it, and keeps its other
 * frames: an area says where a scope is drawn, not what belongs to it, and removing one by
 * accident must not be a way to lose a membership list.
 */
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
