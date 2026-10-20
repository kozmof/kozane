import { warpTable } from "../schema.js";
import { and, asc, eq } from "drizzle-orm";
import type { NeedsDB, NeedsNamespace, NeedsNamespaceWarp, Warp } from "./types.js";
import { assertFound } from "./utils.js";

/** Number warps in UUIDv7 creation order. */
export async function getAllWarps({ db, namespaceId }: NeedsNamespace): Promise<Warp[]> {
  return db
    .select()
    .from(warpTable)
    .where(eq(warpTable.namespaceId, namespaceId))
    .orderBy(asc(warpTable.id));
}

/**
 * List workspace warps for the cross-namespace palette, ordered by namespace and ID.
 * Preserve the creation order used by {@link getAllWarps} so marker numbers stay consistent.
 */
export async function getAllWorkspaceWarps({ db }: NeedsDB): Promise<Warp[]> {
  return db.select().from(warpTable).orderBy(asc(warpTable.namespaceId), asc(warpTable.id));
}

type AddWarp = NeedsNamespace & { posX: number; posY: number };

export async function addWarp({ db, namespaceId, posX, posY }: AddWarp): Promise<Warp> {
  const [row] = await db.insert(warpTable).values({ namespaceId, posX, posY }).returning();
  return row;
}

type MoveWarp = NeedsNamespaceWarp & { posX: number; posY: number };

/**
 * Move a warp and return the stored row so the caller can display its saved position.
 */
export async function moveWarp({ db, namespaceId, warpId, posX, posY }: MoveWarp): Promise<Warp> {
  // Check namespace ownership even though the ID is unique.
  const updated = await db
    .update(warpTable)
    .set({ posX, posY })
    .where(and(eq(warpTable.namespaceId, namespaceId), eq(warpTable.id, warpId)))
    .returning();
  assertFound(updated, `Warp namespaceId=${namespaceId} warpId=${warpId}`);
  return updated[0];
}

type DeleteWarp = NeedsNamespaceWarp;

export async function deleteWarp({ db, namespaceId, warpId }: DeleteWarp): Promise<void> {
  // Check namespace ownership even though the warp ID is unique.
  const deleted = await db
    .delete(warpTable)
    .where(and(eq(warpTable.namespaceId, namespaceId), eq(warpTable.id, warpId)))
    .returning({ id: warpTable.id });
  assertFound(deleted, `Warp namespaceId=${namespaceId} warpId=${warpId}`);
}
